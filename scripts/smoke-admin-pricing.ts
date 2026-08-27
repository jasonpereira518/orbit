/**
 * The pricing levers: is the free cap set right, and is anything in the wrong tier?
 *
 * The assertions worth having are about the *shapes that mislead*. An account sitting at
 * the cap is not evidence of anything on its own — plenty of people stop at 100 contacts
 * because they have 100 contacts. The account that met the paywall, waited a month and did
 * not upgrade is the evidence, and separating those two is the whole job of this module.
 *
 * The other is `null` versus `0` for a feature nobody can measure. A zero reads as "nobody
 * uses this, cut it"; null reads as "we cannot tell". Collapsing them would turn an absent
 * signal into a roadmap decision.
 *
 * Run: npx tsx scripts/smoke-admin-pricing.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, gateEvents, userSettings } from "../src/db/schema";
import { loadAdminUserRows } from "../src/lib/admin-metrics";
import { renderDeep, textOf } from "./lib/render-tree";
import {
  contactCapPicture,
  gateDemand,
  paidFeatureUsage,
  tierFindings,
} from "../src/lib/admin-pricing";
import { recordGateHit } from "../src/lib/gate-events";
import { FREE_CONTACT_LIMIT } from "../src/lib/plan-limits";
import { ensureUserSettings } from "../src/lib/user-settings";

const PREFIX = "smoke-pricing-";
const STALLED = `${PREFIX}stalled`;
const JUSTHIT = `${PREFIX}justhit`;
const NEAR = `${PREFIX}near`;
const CONVERTED = `${PREFIX}converted`;
const ALL = [STALLED, JUSTHIT, NEAR, CONVERTED];

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, ALL));
  await db.delete(gateEvents).where(inArray(gateEvents.userId, ALL));
  await db.delete(userSettings).where(inArray(userSettings.userId, ALL));
}

async function seedContacts(userId: string, n: number) {
  const db = await getDb();
  const batch = Array.from({ length: n }, (_, i) => ({
    userId,
    fullName: `Contact ${i}`,
  }));
  // Chunked: a single insert of 100+ rows exceeds the parameter limit on some drivers.
  for (let i = 0; i < batch.length; i += 50) {
    await db.insert(contacts).values(batch.slice(i, i + 50));
  }
}

async function main() {
  await cleanup();
  for (const id of ALL) await ensureUserSettings(id);

  const db = await getDb();

  await seedContacts(STALLED, FREE_CONTACT_LIMIT);
  await seedContacts(JUSTHIT, FREE_CONTACT_LIMIT);
  await seedContacts(NEAR, FREE_CONTACT_LIMIT - 5);
  await seedContacts(CONVERTED, 10);

  // CONVERTED met the wall while free, then upgraded.
  await db
    .update(userSettings)
    .set({ lifetimePurchasedAt: new Date() })
    .where(eq(userSettings.userId, CONVERTED));

  for (const id of [STALLED, JUSTHIT, CONVERTED]) {
    await recordGateHit({ userId: id, feature: "contacts", plan: "free" });
  }
  // A second refusal for STALLED — bouncing off repeatedly is its own signal.
  await recordGateHit({ userId: STALLED, feature: "contacts", plan: "free" });

  // Backdate STALLED's first refusal past the 30-day line.
  await db.execute(sql`
    UPDATE gate_events
    SET created_at = now() - interval '45 days'
    WHERE user_id = ${STALLED}
      AND created_at = (SELECT min(created_at) FROM gate_events WHERE user_id = ${STALLED})
  `);

  const rows = (await loadAdminUserRows()).filter((r) => ALL.includes(r.userId));
  const cap = await contactCapPicture(rows);

  const ids = (list: Array<{ userId: string }>) => list.map((a) => a.userId);

  /* ------------------------------------------------------------------ at vs stalled */

  check("accounts at the cap are found", ids(cap.atCap).includes(STALLED));
  check("...including one that just arrived", ids(cap.atCap).includes(JUSTHIT));

  // The distinction the screen exists to make. Being at the cap says nothing; being at it
  // for a month having declined to pay is the finding.
  check(
    "only the long-stalled account counts as stalled",
    ids(cap.stalledAtCap).includes(STALLED) &&
      !ids(cap.stalledAtCap).includes(JUSTHIT),
    ids(cap.stalledAtCap).join(",")
  );

  check(
    "repeat refusals are counted",
    (cap.atCap.find((a) => a.userId === STALLED)?.blockedCount ?? 0) === 2
  );

  check(
    "an account approaching the cap is separated from one at it",
    ids(cap.nearCap).includes(NEAR) && !ids(cap.atCap).includes(NEAR)
  );

  // Paid accounts must never appear in a free-cap list, however many contacts they have.
  check("paid accounts are excluded from the cap lists", !ids(cap.atCap).includes(CONVERTED));
  check(
    "...but do count as having converted after meeting the wall",
    cap.convertedAfterBlock >= 1
  );

  const capBand = cap.distribution.find((d) => d.band === `${FREE_CONTACT_LIMIT}+`);
  check("the distribution puts them in the right band", (capBand?.accounts ?? 0) >= 2);

  /* ---------------------------------------------------------------------- gate demand */

  await recordGateHit({ userId: NEAR, feature: "outreach", plan: "free" });
  await recordGateHit({ userId: NEAR, feature: "outreach", plan: "free" });
  await recordGateHit({ userId: JUSTHIT, feature: "outreach", plan: "free" });

  const demand = await gateDemand();
  const outreach = demand.find((d) => d.feature === "outreach");
  check("distinct accounts are counted, not refusals", outreach?.accounts === 2, String(outreach?.accounts));
  check("...and refusals separately", outreach?.hits === 3, String(outreach?.hits));

  /* -------------------------------------------------------------------- tier findings */

  const usage = await paidFeatureUsage();
  const findings = tierFindings(demand, usage);
  const byFeature = new Map(findings.map((f) => [f.feature, f]));

  check(
    "a wall people hit is reported as wanted",
    byFeature.get("outreach")?.verdict === "wanted"
  );

  // The mirror-image finding, and the one that gets missed: nobody wants it AND nobody
  // with access uses it.
  check(
    "a feature nobody wants or uses is reported as unwanted",
    byFeature.get("recruiters")?.verdict === "unwanted",
    byFeature.get("recruiters")?.note
  );

  // Unmeasurable must never render as zero — that would read as "cut it".
  check(
    "an unmeasurable feature is unproven, not unwanted",
    byFeature.get("extension")?.verdict === "unproven" &&
      byFeature.get("extension")?.usedByPaid === null,
    byFeature.get("extension")?.note
  );

  check("every gated feature gets a verdict", findings.length === 6);

  /* --------------------------------------------------------------------- the screen */

  const { default: AdminProductPage } = await import(
    "../src/app/(admin)/admin/product/page"
  );
  // `renderDeep`, because Product streams each panel behind its own Suspense boundary.
  const productTree = await renderDeep(AdminProductPage());
  const productText = textOf(productTree).join(" ");
  check("the Product screen renders", productTree != null);
  check(
    "...and its panels resolve rather than staying fallbacks",
    productText.includes("Which walls people hit") &&
      productText.includes("Is anything in the wrong tier?"),
    productText.slice(0, 240)
  );

  await cleanup();
  console.log("\nAll pricing-lever checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
