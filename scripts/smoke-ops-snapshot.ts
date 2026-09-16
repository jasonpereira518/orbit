/**
 * Asserts `loadOpsSnapshot` reads each ops condition's source rows from a real database,
 * and that the catalogue turns them into the right condition. The pure predicates live in
 * smoke-ops-alerts; this pins the queries behind them.
 *
 * Run: npx tsx scripts/smoke-ops-snapshot.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
// Off production, so the production-only fields stay quiet unless a section sets it.
delete process.env.VERCEL_ENV;

import { and, eq, gt, inArray, like, or, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, cronRuns, embeddingFailures, errorEvents, rateLimitBuckets, usageEvents } from "../src/db/schema";
import { RATE_LIMITS } from "../src/lib/rate-limit";
import { recordBackfillFailure } from "../src/lib/backfill-failures";
import { ERROR_SOURCES } from "../src/lib/error-events";
import { evaluateOpsConditions } from "../src/lib/ops-alerts";
import { loadOpsSnapshot } from "../src/lib/ops-sweep";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const JOBS = ["imports.process-stalled", "webhooks.drain", "sync.run"] as const;

async function cronRun(job: (typeof JOBS)[number], status: "ok" | "partial" | "failed", minutesAgo: number) {
  const db = await getDb();
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await db.insert(cronRuns).values({ job, trigger: "manual", status, startedAt: at, finishedAt: at });
}

async function idsNow(): Promise<string[]> {
  const now = new Date();
  return evaluateOpsConditions(await loadOpsSnapshot(now, null), now).map((c) => c.id);
}

run(async () => {
  const db = await getDb();
  await db.delete(cronRuns).where(inArray(cronRuns.job, [...JOBS]));

  console.log("Cron ledger...");
  await cronRun("imports.process-stalled", "partial", 180);
  await cronRun("imports.process-stalled", "partial", 120);
  await cronRun("imports.process-stalled", "partial", 60);
  await cronRun("webhooks.drain", "failed", 5);
  const snap = await loadOpsSnapshot(new Date(), null);
  check("the last three process-stalled states are read, newest first",
    JSON.stringify(snap.processStalledRecent) === JSON.stringify(["partial", "partial", "partial"]),
    JSON.stringify(snap.processStalledRecent));
  check("the drain's last state is read", snap.cron.drain.lastState === "failed", JSON.stringify(snap.cron.drain));
  let ids = await idsNow();
  check("three partial runs open cron.partial_streak", ids.includes("cron.partial_streak"), ids.join(","));
  check("a failed drain opens drain.failed", ids.includes("drain.failed"), ids.join(","));

  await cronRun("imports.process-stalled", "ok", 1);
  await cronRun("webhooks.drain", "partial", 1);
  ids = await idsNow();
  check("an ok run breaks the streak", !ids.includes("cron.partial_streak"), ids.join(","));
  check("a partial drain is not drain.failed", !ids.includes("drain.failed"), ids.join(","));
  await db.delete(cronRuns).where(inArray(cronRuns.job, [...JOBS]));

  console.log("\nBackfill failures...");
  await db.delete(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.backfillFailed));
  const boom = new Error("Embedding provider answered 500");
  check("the first failure for an account is recorded", await recordBackfillFailure("embeddings", "snap-backfill-a", boom));
  check("a repeat within the hour is throttled", !(await recordBackfillFailure("embeddings", "snap-backfill-a", boom)));
  check("another kind for the same account is its own row", await recordBackfillFailure("linkedin_timeline", "snap-backfill-a", boom));
  await recordBackfillFailure("embeddings", "snap-backfill-b", boom);
  const rows = await db.select().from(errorEvents).where(and(
    eq(errorEvents.source, ERROR_SOURCES.backfillFailed), gt(errorEvents.createdAt, new Date(Date.now() - 60_000))));
  check("three rows, never the raw error text beyond the friendly message", rows.length === 3, JSON.stringify(rows.map((r) => r.kind)));
  const bf = (await loadOpsSnapshot(new Date(), null)).backfillFailures24h;
  check("the snapshot counts distinct accounts and kinds",
    bf.accounts === 2 && bf.kinds.includes("embeddings") && bf.kinds.includes("linkedin_timeline"), JSON.stringify(bf));
  check("two accounts open backfill.failed", (await idsNow()).includes("backfill.failed"));
  await db.delete(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.backfillFailed));

  console.log("\nstatement_timeout...");
  check("not probed off production", (await loadOpsSnapshot(new Date(), null)).statementTimeout === null);
  process.env.VERCEL_ENV = "production";
  try {
    const prodSnap = await loadOpsSnapshot(new Date(), null);
    check("probed in production (PGlite reports 0)", prodSnap.statementTimeout === "0", String(prodSnap.statementTimeout));
    check("which opens config.statement_timeout_unbounded",
      evaluateOpsConditions(prodSnap, new Date()).some((c) => c.id === "config.statement_timeout_unbounded"));
  } finally {
    delete process.env.VERCEL_ENV;
  }

  console.log("\nUnattributed Stripe events...");
  await db.delete(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.stripeUnattributed));
  await db.insert(errorEvents).values([
    { source: ERROR_SOURCES.stripeUnattributed, kind: "checkout.session.completed", context: { eventId: "evt_a" } },
    { source: ERROR_SOURCES.stripeUnattributed, kind: "invoice.paid", context: { eventId: "evt_b" } },
  ]);
  const su = (await loadOpsSnapshot(new Date(), null)).stripeUnattributed24h;
  check("fulfilments and other events are counted apart", su.fulfilments === 1 && su.other === 1, JSON.stringify(su));
  await db.delete(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.stripeUnattributed));

  console.log("\nEmbedding backlog...");
  await db.delete(contacts).where(inArray(contacts.userId, ["snap-backlog", "snap-backlog-fresh"]));
  const base = (await loadOpsSnapshot(new Date(), null)).embeddingBacklog.accounts;
  await db.insert(contacts).values({ userId: "snap-backlog-fresh", fullName: "Fresh Flag", embeddingStaleAt: new Date(Date.now() - 3_600_000) });
  check("a flag an hour old is not counted", (await loadOpsSnapshot(new Date(), null)).embeddingBacklog.accounts === base);
  const staleSince = new Date(Date.now() - 30 * 3_600_000);
  await db.insert(contacts).values({ userId: "snap-backlog", fullName: "Backlog Person", embeddingStaleAt: staleSince });
  const eb = (await loadOpsSnapshot(new Date(), null)).embeddingBacklog;
  check("a flag 30h old counts its account", eb.accounts === base + 1, JSON.stringify(eb));
  check("and the oldest flag is read", eb.oldestAt !== null && eb.oldestAt.getTime() <= staleSince.getTime() + 1000, String(eb.oldestAt));
  check("which opens embedding.backlog", (await idsNow()).includes("embedding.backlog"));
  await db.delete(contacts).where(inArray(contacts.userId, ["snap-backlog", "snap-backlog-fresh"]));

  console.log("\nSync lag...");
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id = 'snap-lag'`);
  await db.execute(sql`INSERT INTO gmail_connections
    (user_id, email_address, access_token_encrypted, status, scopes, next_sync_at, sync_failures)
    VALUES ('snap-lag', 'snap-lag@example.com', 'enc', 'active', 'https://www.googleapis.com/auth/calendar.readonly',
            ${new Date(Date.now() - 3 * 3_600_000)}, 0)`);
  await cronRun("sync.run", "ok", 5);
  const lag = (await loadOpsSnapshot(new Date(), null)).syncOldestDueAgeMs;
  check("the snapshot reads the oldest due connection", (lag ?? 0) >= 3 * 3_600_000 - 60_000, String(lag));
  check("which opens sync.lagging", (await idsNow()).includes("sync.lagging"));
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id = 'snap-lag'`);
  await db.delete(cronRuns).where(inArray(cronRuns.job, [...JOBS]));

  console.log("\nProvider refusals...");
  await db.delete(embeddingFailures).where(eq(embeddingFailures.userId, "snap-unembeddable"));
  await db.delete(usageEvents).where(inArray(usageEvents.userId, ["snap-quota-a", "snap-quota-b"]));
  const before = (await loadOpsSnapshot(new Date(), null)).aiRefusals24h;
  await db.insert(embeddingFailures).values(
    Array.from({ length: 10 }, (_, i) => ({ userId: "snap-unembeddable", sourceType: "profile" as const, sourceId: `c-${i}`, errorKind: "other" }))
  );
  const quotaRow = { operation: "capture.parse", provider: "gemini" as const, model: "gemini-3.5-flash",
    kind: "completion" as const, keyOwner: "user" as const, success: 0, errorKind: "quota" };
  await db.insert(usageEvents).values([
    { ...quotaRow, userId: "snap-quota-a" },
    { ...quotaRow, userId: "snap-quota-a" },
    { ...quotaRow, userId: "snap-quota-b" },
  ]);
  const after = (await loadOpsSnapshot(new Date(), null)).aiRefusals24h;
  check("unembeddable rows in the last day are counted", after.unembeddable === before.unembeddable + 10, JSON.stringify(after));
  check("quota failures are counted per account, not per call", after.quotaAccounts === before.quotaAccounts + 2, JSON.stringify(after));
  const refusalIds = await idsNow();
  check("which open both conditions", refusalIds.includes("embedding.unembeddable") && refusalIds.includes("ai.quota_failures"), refusalIds.join(","));
  await db.delete(embeddingFailures).where(eq(embeddingFailures.userId, "snap-unembeddable"));
  await db.delete(usageEvents).where(inArray(usageEvents.userId, ["snap-quota-a", "snap-quota-b"]));

  console.log("\nDisarmed calendars...");
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id LIKE 'snap-disarmed-%'`);
  const disarmedBefore = (await loadOpsSnapshot(new Date(), null)).calendarDisarmed;
  for (let i = 0; i < 5; i++) {
    await db.execute(sql`INSERT INTO gmail_connections
      (user_id, email_address, access_token_encrypted, status, scopes, next_sync_at, sync_failures, sync_error)
      VALUES (${`snap-disarmed-${i}`}, ${`snap-disarmed-${i}@example.com`}, 'enc', 'active',
              'https://www.googleapis.com/auth/calendar.readonly', NULL, 6, 'Google Calendar 403: forbidden')`);
  }
  // Disarmed without the calendar scope is a Gmail-only account: not counted.
  await db.execute(sql`INSERT INTO gmail_connections
    (user_id, email_address, access_token_encrypted, status, scopes, next_sync_at, sync_failures, sync_error)
    VALUES ('snap-disarmed-mail', 'snap-disarmed-mail@example.com', 'enc', 'active',
            'https://www.googleapis.com/auth/gmail.readonly', NULL, 0, 'Calendar access not granted')`);
  const disarmedAfter = (await loadOpsSnapshot(new Date(), null)).calendarDisarmed;
  check("disarmed calendar connections are counted, mail-only ones are not",
    disarmedAfter === disarmedBefore + 5, `${disarmedBefore} → ${disarmedAfter}`);
  check("five at once open calendar.disarmed", (await idsNow()).includes("calendar.disarmed"));
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id LIKE 'snap-disarmed-%'`);

  console.log("\nShared third-party budgets...");
  const budgetRows = or(like(rateLimitBuckets.bucket, "avatarSource.shared:%"), like(rateLimitBuckets.bucket, "apollo.%"));
  await db.delete(rateLimitBuckets).where(budgetRows);
  const now2 = new Date();
  await db.insert(rateLimitBuckets).values([
    { bucket: "avatarSource.shared:unavatar", windowStartedAt: now2, count: RATE_LIMITS.avatarSourceShared.limit + 1 },
    { bucket: "avatarSource.shared:microlink", windowStartedAt: now2, count: 3 },
    { bucket: "apollo.search:snap-a", windowStartedAt: now2, count: RATE_LIMITS.apolloSearch.limit + 1 },
    { bucket: "apollo.enrich:snap-b", windowStartedAt: now2, count: RATE_LIMITS.apolloEnrich.limit + 4 },
    { bucket: "apollo.enrich:snap-c", windowStartedAt: now2, count: 2 },
    // Refused, but in a window that ended over a day ago: yesterday's news.
    { bucket: "apollo.search:snap-old", windowStartedAt: new Date(Date.now() - 30 * 3_600_000), count: 99 },
  ]);
  const budgets = (await loadOpsSnapshot(new Date(), null)).sharedBudgets;
  check("only the source that went over its budget is exhausted",
    JSON.stringify(budgets.avatarSourcesExhausted) === JSON.stringify(["unavatar"]), JSON.stringify(budgets));
  check("each account over a hosted Apollo cap today is one hit", budgets.apolloCapHits === 2, JSON.stringify(budgets));
  const budgetIds = await idsNow();
  check("which open both conditions",
    budgetIds.includes("avatar.source_exhausted") && budgetIds.includes("apollo.hosted_cap_hits"), budgetIds.join(","));
  await db.delete(rateLimitBuckets).where(budgetRows);

  // (new sections go above this line)

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll ops-snapshot checks passed.");
});
