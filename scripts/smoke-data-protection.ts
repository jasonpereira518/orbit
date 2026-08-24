/**
 * Data protection: does erasure actually work, and does a refused probe leave a trace?
 *
 * THE ORPHAN SWEEP IS THE POINT. Three tables have now reached production user-scoped and
 * unpurged — `outlook_connections`, `suggested_reminders`, `recruiter_messages` — and each
 * was invisible until something enumerated the schema rather than trusting a list.
 * `smoke-purge.ts` catches that in CI against seeded data; this catches it in production
 * against real data, which is where a leak that predates the test still lives. So the
 * assertion that matters is that the sweep *finds* a deliberately orphaned row: a sweep
 * that silently returns nothing looks exactly like a clean database.
 *
 * THE SECOND is that recording a refused admin attempt does not change the refusal. The
 * gate answers 404 rather than 403 on purpose — a 403 confirms the surface exists and that
 * the caller found its path. If adding the audit write ever alters that, the recording has
 * become the information leak the 404 was there to prevent.
 *
 * Run: npx tsx scripts/smoke-data-protection.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq, inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { adminAuditLog, contacts, userSettings } from "../src/db/schema";
import {
  getDataProtection,
  orphanRows,
  recentAccessDenials,
  retentionPicture,
} from "../src/lib/admin-data-protection";
import { ensureUserSettings } from "../src/lib/user-settings";

const PREFIX = "smoke-dp-";
const GHOST = `${PREFIX}ghost`;
const LIVE = `${PREFIX}live`;
const INTRUDER = `${PREFIX}intruder`;
const ALL = [GHOST, LIVE, INTRUDER];

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, ALL));
  await db.delete(adminAuditLog).where(like(adminAuditLog.adminUserId, `${PREFIX}%`));
  await db.delete(userSettings).where(inArray(userSettings.userId, ALL));
}

async function main() {
  await cleanup();
  const db = await getDb();

  await ensureUserSettings(LIVE);
  await db.insert(contacts).values({ userId: LIVE, fullName: "Owned Contact" });

  // Baseline rather than an assertion: the shared dev database may already hold orphans
  // from other suites, and asserting zero here would make this file fail for their reasons.
  // What matters is the DELTA below — that seeding one orphan moves the count by exactly
  // one, and removing it moves it back.
  const baseline =
    (await orphanRows()).find((o) => o.table === "contacts")?.rows ?? 0;

  // The row seeded above has a live owner, so it must not have moved the count.
  check(
    "a contact whose account exists is not counted as orphaned",
    ((await orphanRows()).find((o) => o.table === "contacts")?.rows ?? 0) === baseline
  );

  /* ------------------------------------------------------------------ the orphan sweep */

  // A row whose owning account never existed — exactly what an unpurged table looks like
  // after a deletion.
  await db.insert(contacts).values({ userId: GHOST, fullName: "Orphaned Contact" });

  const withOrphan = await orphanRows();
  const contactsOrphans = withOrphan.find((o) => o.table === "contacts");
  check(
    "the sweep finds a row whose account does not exist",
    (contactsOrphans?.rows ?? 0) === baseline + 1,
    JSON.stringify(withOrphan)
  );

  // A sweep that returns nothing looks identical to a clean database, so proving it can
  // find something is what makes an empty result trustworthy.
  check("...and it is reported against the right table", contactsOrphans !== undefined);

  await db.delete(contacts).where(eq(contacts.userId, GHOST));
  const afterFix = await orphanRows();
  check(
    "removing the orphan clears the finding",
    (afterFix.find((o) => o.table === "contacts")?.rows ?? 0) === baseline
  );

  // `billing_events` is anonymised rather than deleted on purge, so its null-owner rows
  // are correct. Reporting them as orphans would cry wolf on every account deletion.
  check(
    "billing_events is never reported as orphaned",
    !afterFix.some((o) => o.table === "billing_events")
  );

  // `user_settings` IS the account table; every row is its own owner.
  check(
    "user_settings is not swept against itself",
    !afterFix.some((o) => o.table === "user_settings")
  );

  /* --------------------------------------------------------------------- retention */

  const retention = await retentionPicture();
  check("every retention rule states a policy", retention.every((r) => r.policy.length > 0));
  check(
    "contact data is flagged as having no expiry",
    retention.find((r) => r.what.startsWith("Contacts"))?.keptForever === true
  );
  check(
    "usage events are flagged as pruned",
    retention.find((r) => r.what.startsWith("AI usage"))?.keptForever === false
  );

  /* ----------------------------------------------------------------- access denials */

  // The gate cannot be driven without a Clerk request context, so the audit row is written
  // directly — what is asserted is the read path and the shape, not Clerk's behaviour.
  await db.insert(adminAuditLog).values({
    adminUserId: INTRUDER,
    action: "access.denied",
    targetUserId: null,
    detail: {},
  });

  const denials = await recentAccessDenials();
  check(
    "a refused attempt is readable afterwards",
    denials.some((d) => d.userId === INTRUDER),
    denials.map((d) => d.userId).join(",")
  );

  // Denials must not leak into the operator's own action history — they are attempts, not
  // things an admin did.
  const audit = await db
    .select()
    .from(adminAuditLog)
    .where(eq(adminAuditLog.adminUserId, INTRUDER));
  check(
    "the denial carries no target account",
    audit.every((a) => a.targetUserId === null)
  );

  /* ------------------------------------------------------------------- the whole view */

  const picture = await getDataProtection();
  check("the section assembles", picture !== null);
  check(
    "it counts the third-party records Orbit holds",
    picture.thirdPartyRecords !== null && picture.thirdPartyRecords >= 1,
    String(picture.thirdPartyRecords)
  );

  const { default: AdminHealthPage } = await import(
    "../src/app/(admin)/admin/health/page"
  );
  check("the Health screen renders with the section", (await AdminHealthPage()) != null);

  await cleanup();
  console.log("\nAll data-protection checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
