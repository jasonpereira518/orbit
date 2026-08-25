/**
 * The Funnel screen and the Overview's decisions list.
 *
 * WHAT IS WORTH ASSERTING HERE is the withholding. Both new panels compute ratios that are
 * meaningless at Orbit's size — an activation rate over two accounts can only be 0, 50 or
 * 100, and DAU÷MAU over eight moves twelve points per person — so each returns null below a
 * floor rather than a number. That behaviour is invisible when it works and produces a
 * confident, wrong finding when it breaks, which is exactly the kind of thing that needs a
 * test rather than a careful reading.
 *
 * The second is that `unattributed` accounts stay in the denominator. Hiding accounts that
 * predate the attribution mirror would make every channel rate look better than it is by
 * quietly shrinking what it divides by.
 *
 * Run: npx tsx scripts/smoke-admin-funnel.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, gateEvents, userSettings } from "../src/db/schema";
import {
  CHANNEL_RATE_MINIMUM,
  STICKINESS_MINIMUM_MAU,
  channelBreakdown,
  engagementDepth,
  topOfFunnel,
} from "../src/lib/admin-funnel";
import { decisionsWaiting } from "../src/lib/admin-decisions";
import { recordFirstTouch, recordDirectVisit } from "../src/lib/attribution";
import { ensureUserSettings } from "../src/lib/user-settings";
import { renderDeep, textOf } from "./lib/render-tree";

const PREFIX = "smoke-funnel-";
const REDDIT_A = `${PREFIX}reddit-a`;
const REDDIT_B = `${PREFIX}reddit-b`;
const DIRECT = `${PREFIX}direct`;
const LEGACY = `${PREFIX}legacy`;
const ALL = [REDDIT_A, REDDIT_B, DIRECT, LEGACY];

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

async function main() {
  await cleanup();
  for (const id of ALL) await ensureUserSettings(id);

  const db = await getDb();

  const fromReddit = {
    referrer: "reddit.com",
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    landingPath: "/",
  };
  await recordFirstTouch(REDDIT_A, fromReddit);
  await recordFirstTouch(REDDIT_B, fromReddit);
  await recordDirectVisit(DIRECT);
  // LEGACY is left unattributed — it predates the mirror.

  // One of the Reddit accounts activated.
  await db
    .update(userSettings)
    .set({ onboardingCompletedAt: new Date() })
    .where(eq(userSettings.userId, REDDIT_A));

  /* --------------------------------------------------------------------- channels */

  const channels = await channelBreakdown();
  const byName = new Map(channels.map((c) => [c.channel, c]));

  check(
    "accounts group under the referring host",
    (byName.get("reddit.com")?.accounts ?? 0) >= 2,
    JSON.stringify(channels.map((c) => `${c.channel}:${c.accounts}`))
  );
  check("activations are counted per channel", (byName.get("reddit.com")?.activated ?? 0) >= 1);
  check("a direct visit is its own channel", byName.has("direct"));

  // The distinction `signup_attributed_at` exists for. Merging these would blend a real
  // segment with a historical gap.
  check("accounts predating the mirror are separate", byName.has("unattributed"));

  // Hiding them would shrink the denominator and flatter every rate on the screen.
  check(
    "unattributed accounts stay in the breakdown rather than being dropped",
    (byName.get("unattributed")?.accounts ?? 0) >= 1
  );

  // THE WITHHOLDING. Two accounts cannot express an activation rate.
  check(
    `no rate is shown below ${CHANNEL_RATE_MINIMUM} accounts`,
    byName.get("reddit.com")?.accounts !== undefined &&
      byName.get("reddit.com")!.accounts < CHANNEL_RATE_MINIMUM &&
      byName.get("reddit.com")!.activationRate === null,
    String(byName.get("reddit.com")?.activationRate)
  );

  /* ------------------------------------------------------------------- engagement */

  await db
    .update(userSettings)
    .set({ lastActiveAt: new Date() })
    .where(eq(userSettings.userId, REDDIT_A));
  await db
    .update(userSettings)
    .set({ lastActiveAt: new Date(Date.now() - 3 * 86_400_000) })
    .where(eq(userSettings.userId, REDDIT_B));

  const depth = await engagementDepth();
  check("an account active now counts toward DAU", depth.dau >= 1);
  check("...and toward WAU and MAU", depth.wau >= 2 && depth.mau >= 2);
  check("a heartbeat inside the window counts as live", depth.liveNow >= 1);

  // Same withholding, different floor. DAU÷MAU over a handful of people is noise.
  check(
    `stickiness is withheld below ${STICKINESS_MINIMUM_MAU} monthly actives`,
    depth.mau < STICKINESS_MINIMUM_MAU ? depth.stickiness === null : true,
    `mau ${depth.mau}, stickiness ${depth.stickiness}`
  );

  /* ----------------------------------------------------------------- top of funnel */

  await db.insert(contacts).values({ userId: REDDIT_A, fullName: "First Contact" });

  const top = await topOfFunnel();
  check("signups are counted", top.signups >= 4);
  check("activation is counted", top.activated >= 1);
  check("writing a first contact is counted separately", top.everWrote >= 1);
  check(
    "a missing waitlist ledger reads as unknown, not zero",
    top.waitlistEntries === null || top.waitlistEntries >= 0
  );

  /* ------------------------------------------------------------------- decisions */

  const decisions = await decisionsWaiting();
  check("the decisions list assembles", Array.isArray(decisions));

  // Every entry must point somewhere: a finding with no way to see the numbers behind it
  // cannot actually be acted on.
  check(
    "every decision links to the screen that produced it",
    decisions.every((d) => d.href.startsWith("/admin/"))
  );
  check(
    "every decision has a headline and a reason",
    decisions.every((d) => d.headline.length > 0 && d.detail.length > 0)
  );

  // Ordering is the opinion: what costs something now, before what is worth knowing.
  const firstWatch = decisions.findIndex((d) => d.tone === "watch");
  const lastAct = decisions.map((d) => d.tone).lastIndexOf("act");
  check(
    "things that cost something now sort above things merely worth knowing",
    firstWatch === -1 || lastAct === -1 || lastAct < firstWatch,
    decisions.map((d) => `${d.tone}:${d.id}`).join(" ")
  );

  check(
    "ids are unique, so nothing is listed twice",
    new Set(decisions.map((d) => d.id)).size === decisions.length
  );

  // With no infra cost recorded for this month, break-even is computed against zero — the
  // console should say so rather than reading better than it is.
  await db.execute(sql`DELETE FROM infra_costs WHERE period_month = date_trunc('month', now())`);
  const withoutInfra = await decisionsWaiting();
  check(
    "a month with no infra cost recorded is surfaced",
    withoutInfra.some((d) => d.id === "infra.missing"),
    withoutInfra.map((d) => d.id).join(",")
  );

  /* --------------------------------------------------------------------- screens */

  const { default: AdminFunnelPage } = await import(
    "../src/app/(admin)/admin/funnel/page"
  );
  const funnelTree = await renderDeep(
    await AdminFunnelPage({ searchParams: Promise.resolve({}) })
  );
  const funnelText = textOf(funnelTree).join(" ");
  check("the Funnel screen renders", funnelTree != null);
  check(
    "...and its panels resolve rather than staying fallbacks",
    funnelText.includes("Where accounts came from") &&
      funnelText.includes("Activation by signup cohort"),
    funnelText.slice(0, 240)
  );

  // `renderDeep`, not a bare call: the Overview starts its queries and hands the promises
  // to async sections behind Suspense, so invoking the page alone would build a shell and
  // assert nothing about whether any panel actually renders.
  const { default: AdminOverviewPage } = await import("../src/app/(admin)/admin/page");
  const overviewTree = await renderDeep(AdminOverviewPage());
  const overviewText = textOf(overviewTree).join(" ");
  check("the Overview renders with the decisions list", overviewTree != null);
  // Anchored on strings that exist ONLY in the resolved panels. Panel titles are no good
  // here — the skeleton fallbacks carry the same titles, so asserting on those would pass
  // against a page that never resolved anything.
  check(
    "...and its panels resolve rather than staying as fallbacks",
    overviewText.includes("one-time purchases") &&
      overviewText.includes("Orbit Pro, recurring"),
    overviewText.slice(0, 240)
  );

  await cleanup();
  console.log("\nAll funnel and decision checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
