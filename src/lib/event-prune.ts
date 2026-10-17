import { sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { errorEvents, usageEvents } from "@/db/schema";
import { MANAGED_AI_POOLS, poolWindowStart } from "@/lib/managed-ai-policy";
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
 * `pruneOlderThan` for usage_events, sparing Orbit-paid rows still inside THEIR provider's
 * managed AI pool window (`MANAGED_AI_POOLS`). Those rows ARE the pool's ledger
 * (`managedPoolsSpent` sums `key_owner = 'orbit'` per provider since `poolWindowStart`), and a
 * prepaid pool never resets: pruning them at the retention would hand the spent budget back and
 * reopen Orbit's spend. The window is per provider on purpose — a monthly pool's old months,
 * and Orbit spend on a provider with no pool, are no pool's ledger and go as usual, as do BYOK
 * rows and Orbit rows from before a window.
 */
export function pruneUsageEvents(days: number, now: Date = new Date()): Promise<number> {
  const inPoolWindow = Object.entries(MANAGED_AI_POOLS).flatMap(([provider, pool]) =>
    pool ? [sql`(${usageEvents.provider} = ${provider} AND ${usageEvents.createdAt} >= ${poolWindowStart(pool, now).toISOString()})`] : []
  );
  // key_owner, provider and created_at are NOT NULL, so NOT (...) never goes unknown.
  const keep = inPoolWindow.length > 0 ? sql`NOT (${usageEvents.keyOwner} = 'orbit' AND (${sql.join(inPoolWindow, sql` OR `)}))` : undefined;
  return pruneOlderThan(usageEvents, days, keep, now);
}

/**
 * Append-only logs that grew without bound (reliability audit R-07). Table and column names
 * are fixed here and interpolated raw, never taken from input. `keep` limits DELETION to
 * rows that are finished, so a row something is still waiting on is never touched.
 */
export const LOG_RETENTION = [
  // A delivery log; the health page reads the last handful.
  { table: "webhook_deliveries", column: "created_at", days: 30, deletable: "TRUE" },
  // The scheduler's ledger; the sweep reads the latest rows per job. A run still `running`
  // stays so a wedged one can still be told from a finished one.
  { table: "cron_runs", column: "started_at", days: 90, deletable: "status <> 'running'" },
  // Customers' outbound webhook attempts that are done, either way.
  { table: "outbound_webhook_deliveries", column: "created_at", days: 30, deletable: "status IN ('delivered', 'dead', 'failed')" },
] as const;

/** Delete finished rows past each log's retention, in bounded batches. Each table is its own try. */
export async function pruneLogTables(now: Date = new Date()): Promise<Record<string, number>> {
  const db = await getDb();
  const out: Record<string, number> = {};
  for (const t of LOG_RETENTION) {
    const cutoff = new Date(now.getTime() - t.days * 24 * 60 * 60 * 1000).toISOString();
    const deadline = deadlineAfter(PRUNE_BUDGET_MS);
    let pruned = 0;
    try {
      for (;;) {
        const res = await db.execute(sql`
          WITH d AS (
            DELETE FROM ${sql.raw(t.table)} WHERE id IN (
              SELECT id FROM ${sql.raw(t.table)}
               WHERE ${sql.raw(t.column)} < ${cutoff} AND ${sql.raw(t.deletable)} LIMIT ${PRUNE_BATCH}
            )
            RETURNING 1
          )
          SELECT count(*)::int AS n FROM d
        `);
        const n = Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0);
        pruned += n;
        if (n < PRUNE_BATCH || deadlineReached(deadline)) break;
      }
    } catch {
      // One table failing must not skip the others; the next run retries it.
    }
    out[t.table] = pruned;
  }
  return out;
}
