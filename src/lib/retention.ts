import { sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";

/**
 * How long Orbit keeps the rows that only ever accumulate, and the one sweep that enforces it.
 *
 * Every table here grows with traffic or time rather than with anything a person owns, and
 * nothing else deletes from it. Left alone, each becomes one of the largest tables in the
 * database while nobody reads past its first few weeks. `page_views` has its own prune
 * (`prunePageViews`, on the ten-minute ops sweep); this covers the rest, from the hourly
 * backstop in `/api/imports/process-stalled`.
 *
 * BOUNDED PER RUN, like `prunePageViews`: at most `RETENTION_BATCH` rows per rule per run.
 * One unbounded DELETE across a long-neglected table holds its lock for as long as it takes,
 * inside a request with a function timeout. An hourly batch of 5,000 clears 120k rows a
 * day per table, far past any arrival rate here, so a backlog drains over a few runs and
 * then each run is nearly free.
 */
export const RETENTION_BATCH = 5_000;

type RetentionRule = {
  /** Also the key in the result, and in the `cron_runs` stats. */
  table: string;
  /** Primary key column, the handle the batched delete selects by. */
  key: string;
  /** Rows this old or older go. */
  olderThanDays: number;
  /** The timestamp that ages a row. */
  ageColumn: string;
  /** Rows that must stay whatever their age (a delivery still being retried). */
  only?: SQL;
};

/**
 * Why each window is what it is:
 *   usage_events       180d  cost and adoption rollups look back months, never years.
 *   error_events        30d  answers "what is broken now".
 *   gate_events        180d  paywall analytics, the same horizon as usage.
 *   cron_runs           90d  the admin run history and the ops sweep read the last days.
 *   webhook_deliveries  90d  an inbound webhook log; providers stop retrying within days.
 *   outbound deliveries 90d  finished ones only (delivered or dead). The event-id dedupe is
 *                            per day, so a 90-day-old id never recurs.
 *   rate_limit_buckets   2d  every window is a day or less, and a row past its window is
 *                            exactly what the limiter would reset on the next request anyway.
 */
export const RETENTION_RULES: RetentionRule[] = [
  { table: "usage_events", key: "id", ageColumn: "created_at", olderThanDays: 180 },
  { table: "error_events", key: "id", ageColumn: "created_at", olderThanDays: 30 },
  { table: "gate_events", key: "id", ageColumn: "created_at", olderThanDays: 180 },
  { table: "cron_runs", key: "id", ageColumn: "started_at", olderThanDays: 90 },
  { table: "webhook_deliveries", key: "id", ageColumn: "created_at", olderThanDays: 90 },
  {
    table: "outbound_webhook_deliveries",
    key: "id",
    ageColumn: "created_at",
    olderThanDays: 90,
    only: sql`status IN ('delivered', 'dead')`,
  },
  { table: "rate_limit_buckets", key: "bucket", ageColumn: "window_started_at", olderThanDays: 2 },
];

/** One bounded pass of every rule. Returns rows removed per table. A failing rule is skipped. */
export async function pruneRetainedTables(
  now: Date = new Date(),
  onError?: (table: string, err: unknown) => void
): Promise<Record<string, number>> {
  const db = await getDb();
  const removed: Record<string, number> = {};
  for (const rule of RETENTION_RULES) {
    const cutoff = new Date(now.getTime() - rule.olderThanDays * 86_400_000);
    const table = sql.identifier(rule.table);
    const key = sql.identifier(rule.key);
    const age = sql.identifier(rule.ageColumn);
    try {
      // RETURNING the key only, so a batch materialises 5,000 ids rather than 5,000 rows.
      const rows = rowsOf<{ k: unknown }>(
        await db.execute(sql`
          DELETE FROM ${table}
           WHERE ${key} IN (
             SELECT ${key} FROM ${table}
              WHERE ${age} < ${cutoff.toISOString()}
                ${rule.only ? sql`AND ${rule.only}` : sql``}
              LIMIT ${RETENTION_BATCH}
           )
          RETURNING ${key} AS k
        `)
      );
      removed[rule.table] = rows.length;
    } catch (err) {
      removed[rule.table] = 0;
      onError?.(rule.table, err);
    }
  }
  return removed;
}
