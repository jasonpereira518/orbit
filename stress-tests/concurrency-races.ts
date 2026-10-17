/**
 * Check-then-act races on PGlite. PGlite serialises statements, but async interleaving
 * between a read and its dependent write is exactly how the production race manifests on
 * Neon, so a check that fails here fails there too.
 *
 *   npx tsx stress-tests/concurrency-races.ts
 */
import { check, errorText, finding, run, summary } from "./_harness";
import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contacts, creditGrants, creditHolds, rateLimitBuckets, reminderLists, userSettings } from "../src/db/schema";
import { consumeBucket, RateLimitedError } from "../src/lib/rate-limit";
import { ensureUserSettings } from "../src/lib/user-settings";
import { placeHold, settleCredits } from "../src/lib/credits/ledger";
import { createContactForUser } from "../src/lib/contact-writes";
import { getInboxListId } from "../src/lib/reminder-lists";
import { claimPendingPlanUpgrade } from "../src/lib/plan-upgrade-events";
import { planUpgradeEvents } from "../src/db/schema";

const USER = "stress-races";

run(async () => {
  const db = await getDb();
  await ensureUserSettings(USER);

  console.log("Rate limiter under 50 concurrent calls (limit 10)...");
  {
    const key = `race-${Date.now()}`;
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => consumeBucket("stress", key, { limit: 10, windowSec: 60 })));
    const allowed = results.filter((r) => r.status === "fulfilled").length;
    const limited = results.filter((r) => r.status === "rejected" && (r as PromiseRejectedResult).reason instanceof RateLimitedError).length;
    check(`exactly 10 allowed (${allowed}) and 40 limited (${limited})`, allowed === 10 && limited === 40);
  }

  console.log("\nCredit holds: 20 concurrent 0.9-credit holds against a 0.5-credit balance (any one hold drives it negative)...");
  {
    await db.delete(creditHolds).where(eq(creditHolds.userId, USER));
    await db.delete(creditGrants).where(eq(creditGrants.userId, USER));
    await db.insert(creditGrants).values({ userId: USER, kind: "adjustment", grantKey: `adj:${USER}:${Date.now()}`, microsGranted: 500_000, microsRemaining: 500_000 });
    const holds = await Promise.all(Array.from({ length: 20 }, (_, i) => placeHold({ userId: USER, micros: 900_000, operation: `op${i}`, packs: false })));
    const granted = holds.filter(Boolean).length;
    finding("RACE-CREDIT-1", "exactly one hold is granted when the balance cannot cover a second (lock-then-insert must serialise)", granted <= 1, `${granted} holds granted`);
    await db.delete(creditHolds).where(eq(creditHolds.userId, USER));
    // Settle more than the balance: never below zero
    await settleCredits({ userId: USER, operation: "x", micros: 5_000_000 });
    const [g] = await db.select().from(creditGrants).where(eq(creditGrants.userId, USER));
    check("settle never takes a grant below zero", (g?.microsRemaining ?? -1) >= 0, String(g?.microsRemaining));
  }

  console.log("\nFree-plan contact cap: 30 concurrent creates with headroom for 1...");
  {
    await db.delete(contacts).where(eq(contacts.userId, USER));
    // Fill to limit-1 via direct inserts (cheap), then race the last slot.
    const { FREE_CONTACT_LIMIT } = await import("../src/lib/plans/plan-config");
    const rows = Array.from({ length: FREE_CONTACT_LIMIT - 1 }, (_, i) => ({ userId: USER, fullName: `Filler ${i}`, sortKey: `filler ${i}` }));
    for (let i = 0; i < rows.length; i += 200) await db.insert(contacts).values(rows.slice(i, i + 200));
    const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => createContactForUser(USER, { fullName: `Racer ${i}` }, { skipEmbedding: true, skipRevalidate: true, skipSummary: true, skipCloseness: true })));
    const created = results.filter((r) => r.status === "fulfilled").length;
    const [{ n }] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from contacts where user_id = ${USER}`));
    finding("RACE-CAP-1", `free contact cap holds under concurrency (limit ${FREE_CONTACT_LIMIT})`, created === 1 && Number(n) === FREE_CONTACT_LIMIT, `${created} created, ${n} rows (cap ${FREE_CONTACT_LIMIT})`);
    await db.delete(contacts).where(eq(contacts.userId, USER));
  }

  console.log("\nInbox list creation: 10 concurrent first calls...");
  {
    await db.delete(reminderLists).where(eq(reminderLists.userId, USER));
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => getInboxListId(USER)));
    const rejected = results.filter((r) => r.status === "rejected");
    const lists = await db.select().from(reminderLists).where(eq(reminderLists.userId, USER));
    const inboxes = lists.filter((l) => l.nameNormalized === "inbox");
    finding("RACE-INBOX-1", "exactly one Inbox list is created and no call rejects", rejected.length === 0 && inboxes.length === 1, `${inboxes.length} inbox rows, ${rejected.length} rejected: ${rejected.map((r) => errorText((r as PromiseRejectedResult).reason)).join(" | ")}`);
  }

  console.log("\nPlan-upgrade claim: 10 concurrent claims of one pending event...");
  {
    await db.delete(planUpgradeEvents).where(eq(planUpgradeEvents.userId, USER));
    await db.insert(planUpgradeEvents).values({ userId: USER, plan: "pro", source: "stripe", eventKey: `stress:${Date.now()}` } as never);
    const results = await Promise.all(Array.from({ length: 10 }, () => claimPendingPlanUpgrade(USER)));
    const claimed = results.filter(Boolean).length;
    check(`exactly one claim wins (${claimed})`, claimed === 1);
  }

  console.log("\nrate_limit_buckets growth: one row per (scope,key) for every IP/user...");
  {
    const before = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from rate_limit_buckets`))[0].n;
    for (let i = 0; i < 500; i++) await consumeBucket("interestJoin", `ip-${i}-${Date.now()}`, { limit: 10, windowSec: 600 });
    const after = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from rate_limit_buckets`))[0].n;
    check(`500 distinct public callers add ${after - before} rows (pruned only by the hourly process-stalled sweep, 2-day retention, seq scan)`, after - before === 500);
  }
  await db.delete(rateLimitBuckets).where(sql`bucket like 'stress:%' or bucket like 'interestJoin:ip-%'`);
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  summary();
});
