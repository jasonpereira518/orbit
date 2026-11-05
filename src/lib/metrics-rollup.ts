import { and, eq, gte, inArray, lt, lte, ne, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { metricsDaily } from "@/db/schema";
import { intentionalActionsSince } from "@/lib/activity";
import { humanPageViewsSql, visitorDaySql } from "@/lib/admin-analytics";
import { internalAccountSql } from "@/lib/analytics-internal";
import { signupChannelSql } from "@/lib/attribution";
import { currentMrrCents } from "@/lib/billing-events";

/**
 * The daily rollup behind `metrics_daily`: one number per (UTC day, metric, dimension), so a
 * trend chart reads a few hundred rows instead of re-scanning every event table on each load.
 *
 * NO DEFINITION LIVES HERE. Every metric is an existing fragment, counted per UTC day:
 *
 *   signups          `user_settings.created_at` in the day, internal accounts excluded with
 *                    `internalAccountSql` — `userTotalsTrend`'s "added".
 *   signups_channel  the same accounts grouped by `signupChannelSql` (first touch); dim = channel.
 *   dau / wau / mau  distinct accounts in `intentionalActionsSince` (which already excludes
 *                    internal accounts) over the trailing 1 / 7 / 30 days ending at the day's
 *                    close — `rollingActiveTrend`'s windows, so DAU ≤ WAU ≤ MAU holds.
 *   page_views       rows of `humanPageViewsSql` (admin-analytics' `pv()`: no bots, no internal).
 *   visitor_days     distinct `visitorDaySql` pairs in those rows (the hash is salted per UTC
 *                    day, so this is visitor-days, never people).
 *   ai_cost_micros   Σ `usage_events.estimated_cost_micros` (unpriced calls count 0), dim =
 *                    `${operation}|${keyOwner}`. Every account, like `aiOperationCosts`: a cost
 *                    is a cost whoever incurred it.
 *   outreach_emails  outreach email (`channel = 'email'`) by the day each of `sent_at`,
 *                    `delivered_at`, `opened_at`, `clicked_at` fell on; dim = sent | delivered |
 *                    opened | clicked. Internal accounts (via the campaign owner) excluded.
 *   mrr_cents        `currentMrrCents` — a SNAPSHOT of subscription state, not a ledger sum, so
 *                    it can only be recorded for the day the job runs (as of that run). Past
 *                    days' rows are never recomputed.
 *
 * NOT ROLLED UP: "activated". `activatedSql` is a predicate over an account's first seven days,
 * not a moment, so "became activated on day D" has no existing definition; a cohort count by
 * signup day would only settle a week later, after this job stops recomputing the day.
 *
 * IDEMPOTENT. Each day is recomputed from scratch and upserted; rows a recompute no longer
 * produces (a channel that had one signup, since reattributed) are deleted. Running it twice
 * gives the same rows. KEPT FOREVER: a few dozen rows a day with no user ids.
 */

const DAY_MS = 86_400_000;

type Row = { metric: string; dim: string; value: number };

/** The UTC day a Date falls on, as `YYYY-MM-DD`. */
export function utcDay(d: Date): string {
  return new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

const n = (v: unknown) => Number(v ?? 0) || 0;

async function computeDay(dayStart: Date): Promise<Row[]> {
  const s = dayStart.toISOString();
  const e = new Date(dayStart.getTime() + DAY_MS).toISOString();
  const db = await getDb();

  const [head] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      WITH w AS (${intentionalActionsSince(sql`${e}::timestamptz - interval '30 days'`)})
      SELECT
        (SELECT count(*) FROM user_settings
          WHERE created_at >= ${s}::timestamptz AND created_at < ${e}::timestamptz
            AND NOT ${internalAccountSql(sql`user_id`)}) AS signups,
        (SELECT count(DISTINCT user_id) FROM w
          WHERE created_at >= ${e}::timestamptz - interval '1 day' AND created_at < ${e}::timestamptz) AS dau,
        (SELECT count(DISTINCT user_id) FROM w
          WHERE created_at >= ${e}::timestamptz - interval '7 days' AND created_at < ${e}::timestamptz) AS wau,
        (SELECT count(DISTINCT user_id) FROM w WHERE created_at < ${e}::timestamptz) AS mau,
        (SELECT count(*) FROM ${humanPageViewsSql()}
          AND pv.created_at >= ${s}::timestamptz AND pv.created_at < ${e}::timestamptz) AS page_views,
        (SELECT count(DISTINCT ${visitorDaySql}) FROM ${humanPageViewsSql()}
          AND pv.created_at >= ${s}::timestamptz AND pv.created_at < ${e}::timestamptz) AS visitor_days
    `)
  );

  const rows: Row[] = ["signups", "dau", "wau", "mau", "page_views", "visitor_days"].map((metric) => ({
    metric,
    dim: "",
    value: n(head?.[metric]),
  }));

  const channels = rowsOf<{ dim: string; value: unknown }>(
    await db.execute(sql`
      SELECT ${signupChannelSql("s")} AS dim, count(*) AS value
      FROM user_settings s
      WHERE s.created_at >= ${s}::timestamptz AND s.created_at < ${e}::timestamptz
        AND NOT ${internalAccountSql(sql`s.user_id`)}
      GROUP BY 1
    `)
  );
  for (const r of channels) rows.push({ metric: "signups_channel", dim: String(r.dim), value: n(r.value) });

  const ai = rowsOf<{ dim: string; value: unknown }>(
    await db.execute(sql`
      SELECT operation || '|' || key_owner AS dim, coalesce(sum(estimated_cost_micros), 0) AS value
      FROM usage_events
      WHERE created_at >= ${s}::timestamptz AND created_at < ${e}::timestamptz
      GROUP BY operation, key_owner
    `)
  );
  for (const r of ai) rows.push({ metric: "ai_cost_micros", dim: String(r.dim), value: n(r.value) });

  const [mail] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE m.sent_at >= ${s}::timestamptz AND m.sent_at < ${e}::timestamptz) AS sent,
        count(*) FILTER (WHERE m.delivered_at >= ${s}::timestamptz AND m.delivered_at < ${e}::timestamptz) AS delivered,
        count(*) FILTER (WHERE m.opened_at >= ${s}::timestamptz AND m.opened_at < ${e}::timestamptz) AS opened,
        count(*) FILTER (WHERE m.clicked_at >= ${s}::timestamptz AND m.clicked_at < ${e}::timestamptz) AS clicked
      FROM outreach_messages m
      JOIN outreach_prospects p ON p.id = m.prospect_id
      JOIN outreach_campaigns c ON c.id = p.campaign_id
      WHERE m.channel = 'email'
        AND (m.sent_at >= ${s}::timestamptz OR m.delivered_at >= ${s}::timestamptz
             OR m.opened_at >= ${s}::timestamptz OR m.clicked_at >= ${s}::timestamptz)
        AND NOT ${internalAccountSql(sql`c.user_id`)}
    `)
  );
  for (const dim of ["sent", "delivered", "opened", "clicked"]) {
    rows.push({ metric: "outreach_emails", dim, value: n(mail?.[dim]) });
  }

  return rows;
}

/**
 * Recompute and upsert every metric for each UTC day given (any instant in the day will do).
 * Returns how many rows were written. `now` decides which day gets the MRR snapshot.
 */
export async function rollupDays(days: Date[], now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const today = utcDay(now);
  let written = 0;
  for (const day of [...new Set(days.map(utcDay))]) {
    const rows = await computeDay(new Date(`${day}T00:00:00.000Z`));
    if (day === today) rows.push({ metric: "mrr_cents", dim: "", value: await currentMrrCents(now) });
    const at = new Date();
    await db
      .insert(metricsDaily)
      .values(rows.map((r) => ({ day, ...r, computedAt: at })))
      .onConflictDoUpdate({
        target: [metricsDaily.day, metricsDaily.metric, metricsDaily.dim],
        set: { value: sql`excluded.value`, computedAt: sql`excluded.computed_at` },
      });
    // Rows this recompute did not produce (a dimension that vanished) go; metrics it did not
    // compute at all for this day (a past day's MRR snapshot) are left alone.
    await db
      .delete(metricsDaily)
      .where(
        and(
          eq(metricsDaily.day, day),
          inArray(metricsDaily.metric, [...new Set(rows.map((r) => r.metric))]),
          ne(metricsDaily.computedAt, at)
        )
      );
    written += rows.length;
  }
  return written;
}

/** The days the scheduled job recomputes: today and the two before it, so late writes settle. */
export function recentDays(now: Date = new Date(), count = 3): Date[] {
  return Array.from({ length: count }, (_, i) => new Date(now.getTime() - i * DAY_MS));
}

/**
 * A metric's stored series over `[from, to]`, PAST DAYS ONLY (today is still moving and its
 * row is partial). `dim` defaults to '' (an undimensioned metric). Days with no row are
 * absent, not zero: the rollup writes every undimensioned metric for every day it runs, so a
 * gap means the job did not run that day.
 *
 * HOW A CHART SHOULD USE IT. Draw `rollupSeries(metric, { from, to: yesterday })` and append
 * one point for today from the live query that defines the metric (for `dau`, a count over
 * `intentionalActionsSince(startOfTodayUtc)`), so the newest point is never a stale partial.
 * MRR is the exception: its rows are snapshots, so today's point is `currentMrrCents()`.
 */
export async function rollupSeries(
  metric: string,
  opts: { from: Date; to: Date; dim?: string },
  now: Date = new Date()
): Promise<Array<{ day: string; value: number }>> {
  const db = await getDb();
  const rows = await db
    .select({ day: metricsDaily.day, value: metricsDaily.value })
    .from(metricsDaily)
    .where(
      and(
        eq(metricsDaily.metric, metric),
        eq(metricsDaily.dim, opts.dim ?? ""),
        gte(metricsDaily.day, utcDay(opts.from)),
        lte(metricsDaily.day, utcDay(opts.to)),
        lt(metricsDaily.day, utcDay(now))
      )
    )
    .orderBy(metricsDaily.day);
  return rows.map((r) => ({ day: String(r.day), value: Number(r.value) }));
}
