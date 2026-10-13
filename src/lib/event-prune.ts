import { sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { errorEvents, usageEvents } from "@/db/schema";
import { earliestPoolWindowStart } from "@/lib/managed-ai-policy";
import { deadlineAfter, deadlineReached } from "@/lib/time-budget";

/** Rows deleted per statement by `pruneOlderThan`. */
const PRUNE_BATCH = 5_000;

/**
 * Wall-clock ceiling on pruning one table. A backlog still there when it runs out is the
 * next hour's; the resumption work in the process-stalled route is what it exists for.
 */
const PRUNE_BUDGET_MS = 20 * 1000;

/**
 * Deletes rows past the retention window in bounded batches, the way `prunePageViews`
 * does and for its reasons: one unbounded DELETE over a neglected table holds its locks
 * for as long as it takes inside a function with a timeout.
 *
 * Each batch counts itself (`RETURNING 1` into `count(*)`) rather than trusting a
 * driver-specific `rowCount` — neon-http and pglite disagree about the shape of a delete
 * result — so there is no separate count scan, and no deleted row leaves Postgres. Both
 * tables are indexed on created_at.
 *
 * `keep` is an extra condition a row must meet to be DELETED (rows failing it stay, and
 * stay out of the batch, so the loop still ends).
 */
export async function pruneOlderThan(
  table: typeof usageEvents | typeof errorEvents,
  days: number,
  keep?: SQL,
  now: Date = new Date()
): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const deadline = deadlineAfter(PRUNE_BUDGET_MS);
  let pruned = 0;
  for (;;) {
    const res = await db.execute(sql`
      WITH d AS (
        DELETE FROM ${table} WHERE ${table.id} IN (
          SELECT ${table.id} FROM ${table} WHERE ${table.createdAt} < ${cutoff}${keep ? sql` AND ${keep}` : sql``} LIMIT ${PRUNE_BATCH}
        )
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM d
    `);
    const n = Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0);
    pruned += n;
    if (n < PRUNE_BATCH || deadlineReached(deadline)) return pruned;
  }
}

/**
 * `pruneOlderThan` for usage_events, sparing Orbit-paid rows still inside a managed AI pool's
 * window. Those rows ARE the pool's ledger (`managedPoolsSpent` sums them), and a prepaid pool
 * never resets: pruning them at the retention would hand the spent budget back and reopen
 * Orbit's spend. Everything else — BYOK rows, Orbit rows from before the window — goes as usual.
 */
export function pruneUsageEvents(days: number, now: Date = new Date()): Promise<number> {
  const since = earliestPoolWindowStart(now);
  const keep = since
    ? sql`(${usageEvents.keyOwner} IS DISTINCT FROM 'orbit' OR ${usageEvents.createdAt} < ${since.toISOString()})`
    : undefined;
  return pruneOlderThan(usageEvents, days, keep, now);
}
