import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { billingEvents, usageEvents, userSettings } from "@/db/schema";
import { USAGE_EVENT_RETENTION_DAYS } from "@/lib/admin-health";
import type { Grain } from "@/lib/admin-trends";
import { managedCostSql } from "@/lib/ai-access";
import { internalAccountSql } from "@/lib/analytics-internal";
import { signupChannelSql } from "@/lib/attribution";
import {
  compedAccountSql,
  fallbackMonthlyCents,
  fullyRefundedSql,
  monthlyValueCents,
  mrrMovement,
  paidAccountSql,
  type MrrMovement,
} from "@/lib/billing-events";
import { lifetimeTierFor } from "@/lib/billing-stripe";
import { resolvePlan } from "@/lib/entitlements";
import { monthStart } from "@/lib/infra-costs";
import { FEATURE_KEYS, PLAN_CONFIG } from "@/lib/plans/plan-config";
import { monthlyCostSeries, speechMicrosSql, speechSpendByUser, type MonthlyCosts } from "@/lib/money-costs";

/**
 * Time-series and distribution reads for the Money section.
 *
 * Separate from `admin-metrics.ts` (per-account rows) and `admin-trends.ts` (growth) for
 * the same reason those are separate from each other: they answer different questions and
 * are read by different screens. Everything here is either money or the demand for it.
 *
 * Bucketing goes through a gap-filling spine (`utcSeries` below), which is what makes an empty
 * month render as a zero instead of vanishing — a money chart that silently closes a gap is
 * worse than one that fails to draw.
 *
 * EVERY BUCKET IS A UTC BUCKET. `date_trunc` on a timestamptz uses the database SESSION time
 * zone, so the same data bucketed differently under a US-zone session than under Neon's UTC
 * default, and a month of cost could land in the wrong bar (audit 1.14). The spine and the
 * rows both truncate `AT TIME ZONE 'UTC'`, and the bucket comes back as the UTC instant.
 *
 * INTERNAL ACCOUNTS NEVER COUNT. Every reader that aggregates across accounts wraps its
 * user-id column in `internalAccountSql` (admins, the showcase, `account_kind` internal /
 * tester): the operator's own test subscription is not demand, not a signup, not cost.
 */

/** A bucket spine in UTC: one row per period, whether or not anything happened in it. */
function utcSeries(grain: Grain, buckets: number): SQL {
  const step = grain === "month" ? "1 month" : grain === "day" ? "1 day" : "1 week";
  return sql`
    SELECT gs.bucket_start
    FROM generate_series(
      date_trunc(${grain}, now() AT TIME ZONE 'UTC') - (${sql.raw(`interval '${step}'`)} * ${buckets - 1}),
      date_trunc(${grain}, now() AT TIME ZONE 'UTC'),
      ${sql.raw(`interval '${step}'`)}
    ) AS gs(bucket_start)
  `;
}

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
  /** The recurring part of `cashInCents` (subscription invoices) — what Stripe Billing takes its cut of. */
  recurringCents: number;
  chargeCount: number;
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
  const [costs, movements] = await Promise.all([
    monthlyCostSeries(months),
    mrrMovementSeries("month", months, now),
  ]);

  return costs.map((cost, i) => {
    const movement = movements[i];
    const cashInCents = movement?.cashInCents ?? 0;
    const refundedCents = movement?.refundedCents ?? 0;
    return {
      month: cost.month,
      cashInCents,
      recurringCents: movement?.paymentCents ?? 0,
      chargeCount: movement?.chargeCount ?? 0,
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
 * Partly the users' money and partly Orbit's (own keys on Free and Lifetime; included AI
 * on Pro and Max is the costs page's "On Orbit's AI keys" tile) — but it is the
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

  // Per account per bucket: model cost from `usage_events` PLUS Deepgram dollars priced from
  // `speech_usage` seconds (Deepgram rows in `usage_events` carry no cost, by design). Both
  // sides skip internal accounts. `speech_usage` is deliberately unaliased: the shared
  // `speechMicrosSql()` fragment qualifies its columns with the table name.
  const db = await getDb();
  const result = await db.execute(sql`
    WITH spine AS (${utcSeries(grain, bounded)}),
    per_user AS (
      SELECT x.bucket_start, x.user_id, sum(x.micros)::bigint AS micros
      FROM (
        SELECT date_trunc(${grain}, u.created_at AT TIME ZONE 'UTC') AS bucket_start,
               u.user_id,
               coalesce(u.estimated_cost_micros, 0)::bigint AS micros
        FROM usage_events u
        WHERE NOT ${internalAccountSql(sql`u.user_id`)}
        UNION ALL
        SELECT date_trunc(${grain}, speech_usage.created_at AT TIME ZONE 'UTC'),
               speech_usage.user_id,
               round(${speechMicrosSql()})::bigint
        FROM speech_usage
        WHERE NOT ${internalAccountSql(sql`speech_usage.user_id`)}
      ) x
      GROUP BY 1, 2
    )
    SELECT (spine.bucket_start AT TIME ZONE 'UTC') AS bucket_start,
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

/**
 * Where the AI money goes, for the window retention still covers.
 *
 * `orbitKeyMicros` is the managed-AI figure: `managedCostSql()` (the ops / credit definition,
 * with its stand-in for unpriced calls), Orbit's keys only, Deepgram rows excluded — the SAME
 * number `managedAiCostMicros`, the credits section and the ops sweep report. Deepgram is
 * priced from `speech_usage` and reported on its own (`deepgramMicros`), then shown inside
 * `topSpenders`, where an account's voice minutes are part of what it costs.
 */
export async function costToRunBreakdown(days = 30) {
  const db = await getDb();
  const since = new Date(Date.now() - days * 86_400_000);
  const notInternal = sql`NOT ${internalAccountSql(sql`${usageEvents.userId}`)}`;
  const windowed = and(gte(usageEvents.createdAt, since), notInternal);

  const [byModel, byOperation, topSpenders, byOwner, speech] = await Promise.all([
    db
      .select({
        label: sql<string>`${usageEvents.provider} || ' / ' || ${usageEvents.model}`,
        micros: sql<string>`coalesce(sum(${usageEvents.estimatedCostMicros}), 0)`,
        calls: sql<string>`count(*)`,
      })
      .from(usageEvents)
      .where(windowed)
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
      .where(windowed)
      .groupBy(usageEvents.operation)
      .orderBy(desc(sql`sum(${usageEvents.estimatedCostMicros})`))
      .limit(12),
    // Model cost and Deepgram cost per account in one ranking, so a voice-heavy account is
    // not hidden behind a chatty one. `speech_usage` stays unaliased for `speechMicrosSql()`.
    db.execute(sql`
      SELECT t.user_id, sum(t.micros)::bigint AS micros, sum(t.calls)::int AS calls
      FROM (
        SELECT u.user_id, coalesce(u.estimated_cost_micros, 0)::bigint AS micros, 1 AS calls
        FROM usage_events u
        WHERE u.created_at >= ${since} AND NOT ${internalAccountSql(sql`u.user_id`)}
        UNION ALL
        SELECT speech_usage.user_id, round(${speechMicrosSql()})::bigint, 0
        FROM speech_usage
        WHERE speech_usage.created_at >= ${since}
          AND NOT ${internalAccountSql(sql`speech_usage.user_id`)}
      ) t
      GROUP BY t.user_id
      ORDER BY sum(t.micros) DESC, t.user_id
      LIMIT 10
    `),
    db
      .select({
        orbit: sql<string>`coalesce(sum(${managedCostSql()}) FILTER (WHERE ${usageEvents.keyOwner} = 'orbit' AND ${usageEvents.provider} <> 'deepgram'), 0)::bigint`,
        user: sql<string>`coalesce(sum(${usageEvents.estimatedCostMicros}) FILTER (WHERE ${usageEvents.keyOwner} = 'user'), 0)::bigint`,
      })
      .from(usageEvents)
      .where(windowed),
    db.execute(sql`
      SELECT round(coalesce(sum(${speechMicrosSql()}), 0))::bigint AS micros
      FROM speech_usage
      WHERE speech_usage.created_at >= ${since}
        AND NOT ${internalAccountSql(sql`speech_usage.user_id`)}
    `),
  ]);

  const shape = (rows: Array<{ label: string; micros: string; calls: string }>) =>
    rows.map((r) => ({ label: r.label, micros: num(r.micros), calls: num(r.calls) }));

  return {
    byModel: shape(byModel),
    byOperation: shape(byOperation),
    topSpenders: rowsOf<{ user_id: string; micros: string; calls: number }>(topSpenders).map((r) => ({
      userId: r.user_id,
      micros: num(r.micros),
      calls: num(r.calls),
    })),
    orbitKeyMicros: num(byOwner[0]?.orbit),
    userKeyMicros: num(byOwner[0]?.user),
    /** Deepgram dollars over the window, priced from `speech_usage`. Not part of `orbitKeyMicros`. */
    deepgramMicros: num(rowsOf<{ micros: string }>(speech)[0]?.micros),
  };
}

/* ---------------------------------------------------------- demand at the wall ----- */

export type GateDemandRow = {
  feature: string;
  hits: number;
  distinctUsers: number;
  /** How many of those people were on the free plan when they were refused. */
  freeUsers: number;
  /**
   * Of the distinct people refused, how many started a subscription (or upgraded or returned)
   * or bought Lifetime within 30 days of their first refusal AND are still PAID by the shared
   * rule (`paidAccountSql`): not comped, not internal, not refunded in full. A credit pack is
   * not a conversion.
   */
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
      WHERE g.created_at >= ${since} AND NOT ${internalAccountSql(sql`g.user_id`)}
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
                 AND (b.mrr_delta_cents > 0 OR b.kind = 'lifetime')
                 AND b.effective_at >= refused.first_hit
                 AND b.effective_at < refused.first_hit + interval '30 days'
             )
             AND ${paidAccountSql(sql`refused.user_id`)}
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
 * only way that choice can be reviewed rather than merely accumulated. Each comp is priced
 * at its own plan's list price; a comped Lifetime has no monthly price and is counted only.
 */
export async function compedForegoneCents(): Promise<{
  comped: number;
  foregoneMonthlyCents: number;
}> {
  const db = await getDb();
  const rows = await db
    .select({ plan: userSettings.compedPlan, n: sql<string>`count(*)` })
    .from(userSettings)
    .where(
      and(
        sql`${userSettings.compedPlan} IS NOT NULL`,
        sql`NOT ${internalAccountSql(sql`${userSettings.userId}`)}`
      )
    )
    .groupBy(userSettings.compedPlan);

  let comped = 0;
  let foregoneMonthlyCents = 0;
  for (const row of rows) {
    const n = num(row.n);
    comped += n;
    if (row.plan === "orbit" || row.plan === "max") {
      foregoneMonthlyCents += n * (PLAN_CONFIG[row.plan].monthlyPriceCents ?? 0);
    }
  }
  return { comped, foregoneMonthlyCents };
}

/**
 * Recurring revenue currently at risk (Pro and Max), in money: past-due subscriptions (still
 * counted in MRR at full value) and pending cancellations (still paid through). Internal and
 * comped accounts are excluded, and a subscription with no recorded price is valued at its
 * TIER's fallback (`fallbackMonthlyCents`) — the same number live MRR uses.
 */
export async function revenueAtRiskCents(now = new Date()): Promise<{
  pastDueCents: number;
  cancellingCents: number;
  /** `pastDueCents + cancellingCents`: the single "at risk" figure shown beside MRR. */
  atRiskCents: number;
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
        sql`${userSettings.subscriptionPlan} IN ('orbit', 'max')`,
        sql`${userSettings.compedPlan} IS NULL`,
        sql`NOT ${internalAccountSql(sql`${userSettings.userId}`)}`
      )
    );

  let pastDueCents = 0;
  let cancellingCents = 0;
  for (const row of rows) {
    const value = row.monthlyCents ?? fallbackMonthlyCents(row.plan);
    if (row.status === "past_due") pastDueCents += value;
    if (
      row.status === "canceled" &&
      row.periodEnd &&
      row.periodEnd.getTime() > now.getTime()
    ) {
      cancellingCents += value;
    }
  }
  return { pastDueCents, cancellingCents, atRiskCents: pastDueCents + cancellingCents };
}

/**
 * Signup channel rollup, joined to whether the account is PAID — by the one shared rule
 * (`paidAccountSql`: a subscription or Lifetime, not refunded in full). For CAC by channel.
 *
 * Internal / tester accounts and comped accounts are left out of BOTH counts: this feeds a
 * conversion and a cost-per-paid-signup figure, and a comp or the operator's own test signup
 * in either side would flatter or depress it. (This reader used to count MRR rows only, so
 * every Lifetime buyer scored as unpaid, and the Conversion funnel used a third rule.)
 */
export async function paidSignupsByChannel(since: Date) {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT ${signupChannelSql("s")} AS channel,
           count(*)::int AS signups,
           count(*) FILTER (WHERE ${paidAccountSql(sql`s.user_id`)})::int AS paid
    FROM user_settings s
    WHERE s.created_at >= ${since}
      AND NOT ${internalAccountSql(sql`s.user_id`)}
      AND NOT ${compedAccountSql(sql`s.user_id`)}
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
  ...FEATURE_KEYS,
  // Pricing-v2 walls recorded since v171: out of managed credits, the background floor, and the
  // two Deepgram allowances. Without them the Demand page would not list the moments that sell.
  "managedCredits",
  "backgroundFloor",
  "speechShortform",
  "speechMeeting",
] as const;

/* ------------------------------------------------------------ lifetime sales ------- */

export type LifetimeSales = {
  /** Lifetime purchases in the ledger, net of purchases refunded in full. */
  sold: number;
  /** Of those, by offer: the intro price, the standard price, or an amount that matches neither. */
  intro: number;
  standard: number;
  unknown: number;
  /** Cash behind `sold`, as paid (tax-inclusive, as booked). */
  cashCents: number;
};

/**
 * "Lifetime sold": the LEDGER's count of Lifetime purchases, net of full refunds — a sale
 * stays a sale after the buyer's plan changes, and stops being one only when the money went
 * back. This is deliberately not "Lifetime holders" (`countLifetimePurchases`, accounts that
 * hold Lifetime right now, which also drops on account deletion and revocation).
 *
 * The tier comes from `detail.tier` where the booking recorded it, and falls back to the
 * amount paid (tax-tolerant, `lifetimeTierFor`) for rows written before it did. Internal
 * accounts are excluded; rows with no account (anonymised after deletion) still count — the
 * cash was real.
 */
export async function lifetimeSales(): Promise<LifetimeSales> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT b.amount_cents, b.detail->>'tier' AS tier
    FROM billing_events b
    WHERE b.kind = 'lifetime'
      AND NOT ${internalAccountSql(sql`b.user_id`)}
      AND NOT ${fullyRefundedSql(sql`b.user_id`)}
  `);
  const out: LifetimeSales = { sold: 0, intro: 0, standard: 0, unknown: 0, cashCents: 0 };
  for (const r of rowsOf<{ amount_cents: number; tier: string | null }>(result)) {
    const amount = num(r.amount_cents);
    const tier =
      r.tier === "intro" || r.tier === "standard" || r.tier === "unknown"
        ? r.tier
        : lifetimeTierFor({ amount_total: amount });
    out.sold++;
    out[tier]++;
    out.cashCents += amount;
  }
  return out;
}

/* ------------------------------------------------------- unit economics by plan ---- */

export type EconomicsPlan = "free" | "orbit" | "max" | "lifetime" | "comped";
export const ECONOMICS_PLANS: readonly EconomicsPlan[] = ["free", "orbit", "max", "lifetime", "comped"];

/** Lifetime revenue is spread over this many months for the month's economics. */
export const LIFETIME_AMORTISATION_MONTHS = 36;

export type PlanEconomicsRow = {
  plan: EconomicsPlan;
  accounts: number;
  /** This month: subscription value, Lifetime amortised, plus pack cash. Zero for free and comped plans. */
  revenueCents: number;
  /** This month: managed AI on Orbit's keys plus Deepgram, in micros. */
  costMicros: number;
  /** `revenueCents` less the cost in cents. Negative is a plan losing money this month. */
  marginCents: number;
};

export type HeavyUser = {
  /** An account id only: no emails, names or anything else that identifies a person off-console. */
  userId: string;
  plan: EconomicsPlan;
  revenueCents: number;
  costMicros: number;
};

/**
 * Unit economics per plan for the current UTC month, and the accounts that cost more than
 * they bring in.
 *
 * ATTRIBUTABLE COST is what Orbit itself pays to serve an account: managed AI on Orbit's keys
 * (`key_owner = 'orbit'`, the `managedCostSql()` definition, Deepgram rows excluded) PLUS
 * Deepgram priced from `speech_usage`. BYOK spend is the user's money and is not here.
 *
 * REVENUE is what the account is worth this month: a live subscription's monthly value
 * (annual spread over twelve), a Lifetime purchase amortised over 36 months, and any pack
 * cash received this month. Free accounts earn 0. Comped accounts earn 0 and are their own
 * row, so the decision to comp is visible as a cost rather than hidden inside Pro.
 *
 * `heavyUsers` is every account whose month cost exceeds its month revenue, worst first,
 * capped at 25: free accounts with any cost qualify (revenue 0), and so do comped ones.
 * Internal and tester accounts are excluded from everything.
 */
export async function planUnitEconomics(now = new Date()): Promise<{
  rows: PlanEconomicsRow[];
  heavyUsers: HeavyUser[];
  monthStart: Date;
}> {
  const db = await getDb();
  const start = monthStart(now);
  const notInternal = sql`NOT ${internalAccountSql(sql`${userSettings.userId}`)}`;

  const [accounts, aiRows, speech, lifetimeRows, packRows] = await Promise.all([
    db
      .select({
        userId: userSettings.userId,
        compedPlan: userSettings.compedPlan,
        lifetimePurchasedAt: userSettings.lifetimePurchasedAt,
        subscriptionPlan: userSettings.subscriptionPlan,
        subscriptionStatus: userSettings.subscriptionStatus,
        subscriptionPeriodEnd: userSettings.subscriptionPeriodEnd,
        subscriptionMonthlyCents: userSettings.subscriptionMonthlyCents,
      })
      .from(userSettings)
      .where(notInternal),
    db
      .select({
        userId: usageEvents.userId,
        micros: sql<string>`coalesce(sum(${managedCostSql()}), 0)::bigint`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.keyOwner, "orbit"),
          sql`${usageEvents.provider} <> 'deepgram'`,
          gte(usageEvents.createdAt, start),
          lt(usageEvents.createdAt, new Date(now.getTime() + 1))
        )
      )
      .groupBy(usageEvents.userId),
    speechSpendByUser(start, new Date(now.getTime() + 1)),
    db
      .select({
        userId: billingEvents.userId,
        cents: sql<string>`coalesce(sum(${billingEvents.amountCents}), 0)`,
      })
      .from(billingEvents)
      .where(eq(billingEvents.kind, "lifetime"))
      .groupBy(billingEvents.userId),
    db
      .select({
        userId: billingEvents.userId,
        cents: sql<string>`coalesce(sum(${billingEvents.amountCents}), 0)`,
      })
      .from(billingEvents)
      .where(
        and(
          eq(billingEvents.kind, "credit_pack"),
          gte(billingEvents.effectiveAt, start),
          lt(billingEvents.effectiveAt, new Date(now.getTime() + 1))
        )
      )
      .groupBy(billingEvents.userId),
  ]);

  const ai = new Map(aiRows.map((r) => [r.userId, num(r.micros)]));
  const lifetimeCents = new Map(
    lifetimeRows.filter((r) => r.userId).map((r) => [r.userId as string, num(r.cents)])
  );
  const packCents = new Map(packRows.filter((r) => r.userId).map((r) => [r.userId as string, num(r.cents)]));

  const byPlan = new Map<EconomicsPlan, PlanEconomicsRow>(
    ECONOMICS_PLANS.map((plan) => [plan, { plan, accounts: 0, revenueCents: 0, costMicros: 0, marginCents: 0 }])
  );
  const perAccount: HeavyUser[] = [];

  for (const a of accounts) {
    const resolved = resolvePlan(
      {
        compedPlan: a.compedPlan,
        lifetimePurchasedAt: a.lifetimePurchasedAt,
        subscriptionPlan: a.subscriptionPlan,
        subscriptionStatus: a.subscriptionStatus,
        subscriptionPeriodEnd: a.subscriptionPeriodEnd,
      },
      now
    );
    const plan: EconomicsPlan = resolved.source === "comp" ? "comped" : resolved.plan;

    let revenueCents = 0;
    if (resolved.source === "subscription") {
      revenueCents += monthlyValueCents(
        a.subscriptionStatus,
        a.subscriptionPeriodEnd,
        now,
        a.subscriptionMonthlyCents,
        a.subscriptionPlan
      );
    } else if (resolved.source === "lifetime") {
      const months = LIFETIME_AMORTISATION_MONTHS;
      const purchased = a.lifetimePurchasedAt;
      const stillAmortising =
        !purchased ||
        purchased.getTime() > Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate());
      if (stillAmortising) revenueCents += Math.round((lifetimeCents.get(a.userId) ?? 0) / months);
    }
    // Pack cash is real revenue whichever plan the buyer is on, except comped accounts: a
    // comp is "revenue chosen not to collect", and it is shown that way.
    if (plan !== "comped") revenueCents += packCents.get(a.userId) ?? 0;

    const costMicros = (ai.get(a.userId) ?? 0) + (speech.get(a.userId) ?? 0);

    const row = byPlan.get(plan)!;
    row.accounts++;
    row.revenueCents += revenueCents;
    row.costMicros += costMicros;

    if (costMicros > 0 && costMicros / 10_000 > revenueCents) {
      perAccount.push({ userId: a.userId, plan, revenueCents, costMicros });
    }
  }

  const rows = ECONOMICS_PLANS.map((plan) => {
    const row = byPlan.get(plan)!;
    return { ...row, marginCents: Math.round(row.revenueCents - row.costMicros / 10_000) };
  });
  const heavyUsers = perAccount
    .sort((x, y) => y.costMicros / 10_000 - y.revenueCents - (x.costMicros / 10_000 - x.revenueCents) || x.userId.localeCompare(y.userId))
    .slice(0, 25);

  return { rows, heavyUsers, monthStart: start };
}
