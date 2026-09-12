import { and, desc, gte, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { billingEvents, usageEvents, userSettings } from "@/db/schema";
import { USAGE_EVENT_RETENTION_DAYS } from "@/lib/admin-health";
import { series, type Grain } from "@/lib/admin-trends";
import { mrrMovement, type MrrMovement } from "@/lib/billing-events";
import { monthlyCostSeries, type MonthlyCosts } from "@/lib/money-costs";

/**
 * Time-series and distribution reads for the Money section.
 *
 * Separate from `admin-metrics.ts` (per-account rows) and `admin-trends.ts` (growth) for
 * the same reason those are separate from each other: they answer different questions and
 * are read by different screens. Everything here is either money or the demand for it.
 *
 * Bucketing goes through `series()` from `admin-trends.ts` rather than a local copy. That
 * spine is what makes an empty month render as a zero instead of vanishing, and a money
 * chart that silently closes a gap is worse than one that fails to draw.
 */

function toDate(value: Date | string | null | undefined): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function num(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/* ------------------------------------------------------------ MRR over time -------- */

export type MovementPoint = { bucketStart: Date } & MrrMovement;

/**
 * `mrrMovement` bucketed over time.
 *
 * One query per bucket, deliberately. At Orbit's volume this is a handful of round trips
 * against an indexed column, and the alternative — reimplementing the kind-to-column
 * mapping as a windowed SQL aggregate — would mean two places that decide what counts as
 * recurring, which is exactly the drift the ledger exists to prevent.
 */
export async function mrrMovementSeries(
  grain: Grain = "month",
  buckets = 6,
  now = new Date()
): Promise<MovementPoint[]> {
  const bounds: Array<{ start: Date; end: Date }> = [];
  for (let i = buckets - 1; i >= 0; i--) {
    if (grain === "month") {
      const start = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)
      );
      const end = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)
      );
      bounds.push({ start, end });
    } else {
      const end = new Date(now.getTime() - i * 7 * 86_400_000);
      bounds.push({ start: new Date(end.getTime() - 7 * 86_400_000), end });
    }
  }

  const results = await Promise.all(
    bounds.map((b) => mrrMovement(b.start, b.end))
  );
  return results.map((movement, i) => ({
    bucketStart: bounds[i]!.start,
    ...movement,
  }));
}

/* -------------------------------------------------------- revenue against cost ----- */

export type CashFlowPoint = {
  month: Date;
  cashInCents: number;
  refundedCents: number;
  costs: MonthlyCosts;
  /** Cash in, less refunds, less every cost. Negative is a loss, and is shown as one. */
  contributionCents: number;
  infraMissing: boolean;
};

/**
 * The margin picture: what came in against what went out, month by month.
 *
 * Costs come from `monthlyCosts`, which is also what Runway's burn reads — so the two
 * screens cannot quote different numbers for the same month.
 */
export async function cashFlowSeries(
  months = 6,
  now = new Date()
): Promise<CashFlowPoint[]> {
  const costs = await monthlyCostSeries(months);
  const movements = await mrrMovementSeries("month", months, now);

  return costs.map((cost, i) => {
    const movement = movements[i];
    const cashInCents = movement?.cashInCents ?? 0;
    const refundedCents = movement?.refundedCents ?? 0;
    return {
      month: cost.month,
      cashInCents,
      refundedCents,
      costs: cost,
      contributionCents: cashInCents - refundedCents - cost.totalCents,
      infraMissing: cost.infraMissing,
    };
  });
}

/* ------------------------------------------------------------- cost to run --------- */

export type CostToRunPoint = {
  bucketStart: Date;
  /** Distinct accounts that made at least one AI call in the bucket. */
  activeUsers: number;
  totalMicros: number;
  /** Per-user spend at the median, 90th percentile and maximum. */
  p50Micros: number;
  p90Micros: number;
  maxMicros: number;
};

/**
 * What Orbit costs the people who use it, as a DISTRIBUTION rather than an average.
 *
 * Production is strictly BYOK, so this is the users' money, not Orbit's — but it is the
 * number that decides whether BYOK stays viable, and a mean hides the only interesting
 * case. One power user at fifty times the median is the whole story, and an average
 * reports it as a mild uptick.
 *
 * BUCKETS ARE CLAMPED TO THE RETENTION WINDOW. `usage_events` older than
 * `USAGE_EVENT_RETENTION_DAYS` is pruned by the nightly job, so asking for more months
 * than that renders the pruned ones as real zeros — a confident decline in AI cost that
 * is entirely the delete job. `aiVolumeTrend` clamps for the same reason.
 */
export async function costToRunPerUser(
  grain: Grain = "month",
  buckets = 6
): Promise<{ points: CostToRunPoint[]; clamped: boolean }> {
  const maxBuckets =
    grain === "month"
      ? Math.floor(USAGE_EVENT_RETENTION_DAYS / 30)
      : Math.floor(USAGE_EVENT_RETENTION_DAYS / 7);
  const bounded = Math.min(buckets, Math.max(maxBuckets, 1));

  const db = await getDb();
  const result = await db.execute(sql`
    WITH spine AS (${series(grain, bounded)}),
    per_user AS (
      SELECT date_trunc(${grain}, u.created_at) AS bucket_start,
             u.user_id,
             sum(coalesce(u.estimated_cost_micros, 0))::bigint AS micros
      FROM usage_events u
      GROUP BY 1, 2
    )
    SELECT spine.bucket_start,
           count(per_user.user_id)::int AS active_users,
           coalesce(sum(per_user.micros), 0)::bigint AS total_micros,
           coalesce(
             percentile_cont(0.5) WITHIN GROUP (ORDER BY per_user.micros), 0
           )::bigint AS p50_micros,
           coalesce(
             percentile_cont(0.9) WITHIN GROUP (ORDER BY per_user.micros), 0
           )::bigint AS p90_micros,
           coalesce(max(per_user.micros), 0)::bigint AS max_micros
    FROM spine
    LEFT JOIN per_user ON per_user.bucket_start = spine.bucket_start
    GROUP BY spine.bucket_start
    ORDER BY spine.bucket_start
  `);

  const points = rowsOf<{
    bucket_start: string;
    active_users: number;
    total_micros: string;
    p50_micros: string;
    p90_micros: string;
    max_micros: string;
  }>(result).map((r) => ({
    bucketStart: toDate(r.bucket_start),
    activeUsers: num(r.active_users),
    totalMicros: num(r.total_micros),
    p50Micros: num(r.p50_micros),
    p90Micros: num(r.p90_micros),
    maxMicros: num(r.max_micros),
  }));

  return { points, clamped: bounded < buckets };
}

/** Where the AI money goes, for the window retention still covers. */
export async function costToRunBreakdown(days = 30) {
  const db = await getDb();
  const since = new Date(Date.now() - days * 86_400_000);

  const [byModel, byOperation, topSpenders, byOwner] = await Promise.all([
    db
      .select({
        label: sql<string>`${usageEvents.provider} || ' / ' || ${usageEvents.model}`,
        micros: sql<string>`coalesce(sum(${usageEvents.estimatedCostMicros}), 0)`,
        calls: sql<string>`count(*)`,
      })
      .from(usageEvents)
      .where(gte(usageEvents.createdAt, since))
      .groupBy(usageEvents.provider, usageEvents.model)
      .orderBy(desc(sql`sum(${usageEvents.estimatedCostMicros})`))
      .limit(12),
    db
      .select({
        label: usageEvents.operation,
        micros: sql<string>`coalesce(sum(${usageEvents.estimatedCostMicros}), 0)`,
        calls: sql<string>`count(*)`,
      })
      .from(usageEvents)
      .where(gte(usageEvents.createdAt, since))
      .groupBy(usageEvents.operation)
      .orderBy(desc(sql`sum(${usageEvents.estimatedCostMicros})`))
      .limit(12),
    db
      .select({
        userId: usageEvents.userId,
        micros: sql<string>`coalesce(sum(${usageEvents.estimatedCostMicros}), 0)`,
        calls: sql<string>`count(*)`,
      })
      .from(usageEvents)
      .where(gte(usageEvents.createdAt, since))
      .groupBy(usageEvents.userId)
      .orderBy(desc(sql`sum(${usageEvents.estimatedCostMicros})`))
      .limit(10),
    // `orbit` can only happen off-Vercel, so anything here is either local-dev rows in a
    // shared database or a genuine key leak. Either way it is worth seeing.
    db
      .select({
        keyOwner: usageEvents.keyOwner,
        micros: sql<string>`coalesce(sum(${usageEvents.estimatedCostMicros}), 0)`,
      })
      .from(usageEvents)
      .where(gte(usageEvents.createdAt, since))
      .groupBy(usageEvents.keyOwner),
  ]);

  const shape = (rows: Array<{ label: string; micros: string; calls: string }>) =>
    rows.map((r) => ({ label: r.label, micros: num(r.micros), calls: num(r.calls) }));

  return {
    byModel: shape(byModel),
    byOperation: shape(byOperation),
    topSpenders: topSpenders.map((r) => ({
      userId: r.userId,
      micros: num(r.micros),
      calls: num(r.calls),
    })),
    orbitKeyMicros: num(
      byOwner.find((r) => r.keyOwner === "orbit")?.micros
    ),
    userKeyMicros: num(byOwner.find((r) => r.keyOwner === "user")?.micros),
  };
}

/* ---------------------------------------------------------- demand at the wall ----- */

export type GateDemandRow = {
  feature: string;
  hits: number;
  distinctUsers: number;
  /** How many of those people were on the free plan when they were refused. */
  freeUsers: number;
  /** Of the distinct people refused, how many produced revenue within 30 days. */
  converted: number;
};

/**
 * Demand for things people could not reach.
 *
 * `usage_events` records what happened and by construction cannot record what someone
 * tried to do and could not, which makes `gate_events` the only evidence of demand for a
 * feature nobody could get to. A wall people bounce off repeatedly is a feature they would
 * pay for; a wall nobody ever reaches is in the wrong tier — and that reads here as an
 * absent row, which is why the caller should list every known gate, not just the hit ones.
 *
 * Conversion is deliberately counted per PERSON, not per hit. One person hitting a wall
 * forty times is one person who wanted the feature, and counting hits would make the
 * noisiest wall look like the most valuable one.
 */
export async function gateDemand(days = 30): Promise<GateDemandRow[]> {
  const db = await getDb();
  const since = new Date(Date.now() - days * 86_400_000);

  const result = await db.execute(sql`
    WITH refused AS (
      SELECT g.feature, g.user_id, min(g.created_at) AS first_hit,
             count(*)::int AS hits,
             bool_or(g.plan = 'free') AS was_free
      FROM gate_events g
      WHERE g.created_at >= ${since}
      GROUP BY g.feature, g.user_id
    )
    SELECT refused.feature,
           sum(refused.hits)::int AS hits,
           count(*)::int AS distinct_users,
           count(*) FILTER (WHERE refused.was_free)::int AS free_users,
           count(*) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM billing_events b
               WHERE b.user_id = refused.user_id
                 AND b.mrr_delta_cents > 0
                 AND b.effective_at >= refused.first_hit
                 AND b.effective_at < refused.first_hit + interval '30 days'
             )
           )::int AS converted
    FROM refused
    GROUP BY refused.feature
    ORDER BY distinct_users DESC, hits DESC
  `);

  return rowsOf<{
    feature: string;
    hits: number;
    distinct_users: number;
    free_users: number;
    converted: number;
  }>(result).map((r) => ({
    feature: r.feature,
    hits: num(r.hits),
    distinctUsers: num(r.distinct_users),
    freeUsers: num(r.free_users),
    converted: num(r.converted),
  }));
}

/* --------------------------------------------------------------- comps ------------- */

/**
 * What the comped accounts would be paying.
 *
 * The screen currently reports comps as a headcount, which makes a deliberate decision
 * look free. It is not free — it is revenue chosen not to collect, and pricing it is the
 * only way that choice can be reviewed rather than merely accumulated.
 */
export async function compedForegoneCents(monthlyCents: number): Promise<{
  comped: number;
  foregoneMonthlyCents: number;
}> {
  const db = await getDb();
  const rows = await db
    .select({ n: sql<string>`count(*)` })
    .from(userSettings)
    .where(sql`${userSettings.compedPlan} = 'orbit'`);

  const comped = num(rows[0]?.n);
  return { comped, foregoneMonthlyCents: comped * monthlyCents };
}

/** Recurring revenue currently at risk: past-due and pending cancellations, in money. */
export async function revenueAtRiskCents(now = new Date()): Promise<{
  pastDueCents: number;
  cancellingCents: number;
}> {
  const db = await getDb();
  const rows = await db
    .select({
      status: userSettings.subscriptionStatus,
      periodEnd: userSettings.subscriptionPeriodEnd,
      monthlyCents: userSettings.subscriptionMonthlyCents,
      comped: userSettings.compedPlan,
      plan: userSettings.subscriptionPlan,
    })
    .from(userSettings)
    .where(
      and(
        sql`${userSettings.subscriptionPlan} = 'orbit'`,
        sql`${userSettings.compedPlan} IS NULL`
      )
    );

  let pastDueCents = 0;
  let cancellingCents = 0;
  for (const row of rows) {
    const value = row.monthlyCents ?? 500;
    if (row.status === "past_due") pastDueCents += value;
    if (
      row.status === "canceled" &&
      row.periodEnd &&
      row.periodEnd.getTime() > now.getTime()
    ) {
      cancellingCents += value;
    }
  }
  return { pastDueCents, cancellingCents };
}

/** Signup channel rollup, joined to whether the account ever paid. For CAC by channel. */
export async function paidSignupsByChannel(since: Date) {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT coalesce(
             nullif(s.signup_utm_source, ''),
             nullif(s.signup_referrer, ''),
             CASE WHEN s.signup_attributed_at IS NULL THEN 'unattributed' ELSE 'direct' END
           ) AS channel,
           count(*)::int AS signups,
           count(*) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM billing_events b
               WHERE b.user_id = s.user_id AND b.mrr_delta_cents > 0
             )
           )::int AS paid
    FROM user_settings s
    WHERE s.created_at >= ${since}
    GROUP BY 1
    ORDER BY paid DESC, signups DESC
  `);

  return rowsOf<{ channel: string; signups: number; paid: number }>(result).map((r) => ({
    channel: r.channel,
    signups: num(r.signups),
    paid: num(r.paid),
  }));
}

/** Raw ledger rows for the movements panel, newest first. */
export async function recentMovements(limit = 25) {
  const db = await getDb();
  return db
    .select()
    .from(billingEvents)
    .orderBy(desc(billingEvents.effectiveAt))
    .limit(limit);
}

/** Gate features that exist in the product, so an unhit wall shows as an empty row. */
export const KNOWN_GATES = [
  "contacts",
  "outreach",
  "hostedSending",
  "hostedEnrichment",
  "recruiters",
  "sync",
  "extension",
] as const;
