import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { num } from "@/lib/admin-metrics";

/**
 * Historical data for the console's trend charts.
 *
 * Three of these four read functions touch no new storage: MRR, signups and activation
 * are all real events with real timestamps already sitting in `billing_events` and
 * `user_settings`, so a history is a `GROUP BY date(...)`, not a new table. Only
 * `snapshotTrend` reads `admin_metric_snapshots` — for the handful of metrics that are a
 * fact about a moment (e.g. "how many were active in the last 7 days") rather than an
 * event, and so have no other way to be known historically. See the daily cron at
 * `src/app/api/admin/metrics-snapshot/route.ts` for what populates that table.
 */

export type TrendPoint = { date: string; value: number };

function since(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * MRR at the end of each day over the trailing window, reconstructed from the signed
 * ledger rather than sampled — the cumulative sum runs over ALL history before the date
 * filter is applied, so day one of the window still reflects everything that happened
 * before it. Filtering first would silently restart the running total at zero.
 */
export async function mrrTrend(days: number): Promise<TrendPoint[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    WITH daily AS (
      SELECT date(effective_at) AS day, sum(mrr_delta_cents)::int AS delta
      FROM billing_events
      GROUP BY date(effective_at)
    ),
    cumulative AS (
      SELECT day, sum(delta) OVER (ORDER BY day)::int AS mrr_cents
      FROM daily
    )
    SELECT day, mrr_cents
    FROM cumulative
    WHERE day >= ${since(days)}
    ORDER BY day
  `);
  return rowsOf<{ day: string; mrr_cents: number }>(result).map((r) => ({
    date: r.day,
    value: num(r.mrr_cents),
  }));
}

export type SignupTrendPoint = { date: string; signups: number; activated: number };

/** New signups and new activations per day — daily volume, not a running total. */
export async function signupTrend(days: number): Promise<SignupTrendPoint[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT
      date(created_at) AS day,
      count(*)::int AS signups,
      count(onboarding_completed_at) FILTER (
        WHERE date(onboarding_completed_at) = date(created_at)
      )::int AS same_day_activated
    FROM user_settings
    WHERE created_at >= ${since(days)}
    GROUP BY date(created_at)
    ORDER BY day
  `);
  return rowsOf<{ day: string; signups: number; same_day_activated: number }>(
    result
  ).map((r) => ({
    date: r.day,
    signups: num(r.signups),
    activated: num(r.same_day_activated),
  }));
}

/** Errors per day. Relies on `error_events` retaining 90 days — see the retention bump in process-stalled/route.ts. */
export async function errorTrend(days: number): Promise<TrendPoint[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT date(created_at) AS day, count(*)::int AS n
    FROM error_events
    WHERE created_at >= ${since(days)}
    GROUP BY date(created_at)
    ORDER BY day
  `);
  return rowsOf<{ day: string; n: number }>(result).map((r) => ({
    date: r.day,
    value: num(r.n),
  }));
}

/** History for a metric the console snapshots daily because no ledger can reconstruct it. */
export async function snapshotTrend(metric: string, days: number): Promise<TrendPoint[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT captured_at, value
    FROM admin_metric_snapshots
    WHERE metric = ${metric} AND captured_at >= ${since(days)}
    ORDER BY captured_at
  `);
  return rowsOf<{ captured_at: string; value: number }>(result).map((r) => ({
    date: r.captured_at,
    value: num(r.value),
  }));
}
