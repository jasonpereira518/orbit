import { and, count, eq, gt, gte, lte, sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, creditGrants, planMeterUsage, speechUsage, userSettings } from "@/db/schema";
import { internalAccountSql } from "@/lib/analytics-internal";
import { MICROS_PER_CREDIT } from "@/lib/credits/grants";
import { resolvePlan, type BillingColumns } from "@/lib/entitlements";
import { notTourExample } from "@/lib/onboarding-examples/sql";
import { meterPeriodKey } from "@/lib/plan-meters";
import { PLANS, type Plan, type PlanConfig } from "@/lib/plans/plan-config";
import { getEffectivePlanConfig } from "@/lib/plans/plan-rules";
import { monthWindow } from "@/lib/speech-limits";

/**
 * /admin/billing/usage: how much of each plan allowance accounts have used. Read-only.
 *
 * Every figure comes from the table its gate already reads, so this page and the gate cannot
 * disagree: credits from this cycle's allowance grant (`credit_grants`), speech from
 * `speech_usage` since the UTC month start, hosted enrichment from `plan_meter_usage`, contacts
 * as a count against `contactLimit`. Limits are the EFFECTIVE plan table (operator overrides
 * applied), read once — never a per-account call. Internal and tester accounts are left out.
 */

export const ALLOWANCES = ["credits", "meeting", "shortform", "assistant", "enrichment", "contacts"] as const;
export type Allowance = (typeof ALLOWANCES)[number];

export const ALLOWANCE_LABELS: Record<Allowance, string> = {
  credits: "AI credits",
  meeting: "Meeting speech",
  shortform: "Short-form speech",
  assistant: "Cosmo talk",
  enrichment: "Hosted enrichment",
  contacts: "Contacts",
};

/** `limit: null` = no cap. Credits in credits, speech in seconds, the rest in counts. */
export type Meter = { used: number; limit: number | null };

export type AccountUsage = {
  userId: string;
  plan: Plan;
  meters: Record<Allowance, Meter>;
  /** The highest used/limit across capped allowances (Infinity: used against a zero cap). */
  peak: number;
};

/** Per-account usage readings, keyed by user id. Missing = nothing used. */
export type UsageReadings = {
  /** This cycle's allowance grant, in micros. */
  credits: Map<string, { granted: number; remaining: number }>;
  meeting: Map<string, number>;
  shortform: Map<string, number>;
  /** Seconds talking with Cosmo (connected call time, as src/lib/voice/minutes.ts counts it). */
  assistant: Map<string, number>;
  enrichment: Map<string, number>;
  contacts: Map<string, number>;
};

function limitOf(allowance: Allowance, c: PlanConfig): number | null {
  switch (allowance) {
    case "credits":
      return c.monthlyCredits ?? 0;
    case "meeting":
      return c.speech.meetingSeconds;
    case "shortform":
      return c.speech.shortformSeconds;
    case "assistant":
      return c.speech.assistantSeconds;
    case "enrichment":
      return c.hostedEnrichmentsPerMonth;
    case "contacts":
      return c.contactLimit;
  }
}

/** Pure: each account's meters against its plan's effective limits, fullest first. */
export function accountUsage(
  accounts: Array<{ userId: string; plan: Plan }>,
  r: UsageReadings,
  config: Record<Plan, PlanConfig>
): AccountUsage[] {
  return accounts
    .map(({ userId, plan }) => {
      const meters = {} as Record<Allowance, Meter>;
      for (const a of ALLOWANCES) meters[a] = { used: 0, limit: limitOf(a, config[plan]) };
      const grant = r.credits.get(userId);
      if (grant) {
        // The grant is the truth for this cycle (a mid-cycle upgrade raised it), not the plan row.
        meters.credits = {
          used: (grant.granted - grant.remaining) / MICROS_PER_CREDIT,
          limit: grant.granted / MICROS_PER_CREDIT,
        };
      }
      meters.meeting.used = r.meeting.get(userId) ?? 0;
      meters.shortform.used = r.shortform.get(userId) ?? 0;
      meters.assistant.used = r.assistant.get(userId) ?? 0;
      meters.enrichment.used = r.enrichment.get(userId) ?? 0;
      meters.contacts.used = r.contacts.get(userId) ?? 0;
      let peak = 0;
      for (const m of Object.values(meters)) {
        if (m.limit === null || m.used <= 0) continue;
        peak = Math.max(peak, m.limit === 0 ? Infinity : m.used / m.limit);
      }
      return { userId, plan, meters, peak };
    })
    .sort((x, y) => y.peak - x.peak);
}

export type PlanTotals = { plan: Plan; accounts: number; meters: Record<Allowance, Meter> };

/** Pure: sums per plan. A plan's limit is null when any of its accounts has no cap. */
export function totalsByPlan(rows: AccountUsage[]): PlanTotals[] {
  return PLANS.map((plan) => {
    const mine = rows.filter((r) => r.plan === plan);
    const meters = {} as Record<Allowance, Meter>;
    for (const a of ALLOWANCES) {
      const uncapped = mine.some((r) => r.meters[a].limit === null);
      meters[a] = {
        used: mine.reduce((s, r) => s + r.meters[a].used, 0),
        limit: uncapped ? null : mine.reduce((s, r) => s + (r.meters[a].limit ?? 0), 0),
      };
    }
    return { plan, accounts: mine.length, meters };
  }).filter((t) => t.accounts > 0);
}

export type UsageTrendPoint = { month: string } & Record<Allowance, number>;

const num = (v: unknown) => Number(v ?? 0);
const byUser = (rows: Array<{ userId: string | null; v: unknown }>) =>
  new Map(rows.flatMap((r) => (r.userId ? [[r.userId, num(r.v)] as const] : [])));
const notInternal = (col: SQL) => sql`NOT ${internalAccountSql(col)}`;
/** A call's talk time in seconds: the raw-SQL twin of `talked` in src/lib/voice/minutes.ts; change both together. */
const TALKED = sql.raw(
  "greatest(0, extract(epoch from (least(coalesce(ended_at, last_seen_at, connected_at), expires_at) - connected_at)))"
);

export async function loadAdminUsage(now = new Date()) {
  const db = await getDb();
  const config = await getEffectivePlanConfig();
  const { start: monthStart } = monthWindow(now);
  const trendStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));

  const [accounts, grants, speech, meters, contactCounts, creditTrend, speechTrend, meterTrend, contactTrend, talk, talkTrend] =
    await Promise.all([
      db
        .select({
          userId: userSettings.userId,
          compedPlan: userSettings.compedPlan,
          lifetimePurchasedAt: userSettings.lifetimePurchasedAt,
          subscriptionPlan: userSettings.subscriptionPlan,
          subscriptionStatus: userSettings.subscriptionStatus,
          subscriptionPeriodEnd: userSettings.subscriptionPeriodEnd,
        })
        .from(userSettings)
        .where(notInternal(sql`${userSettings.userId}`)),
      // The allowance grant covering now IS the account's current period (its own billing cycle).
      db
        .select({
          userId: creditGrants.userId,
          granted: sql<string>`sum(${creditGrants.microsGranted})`,
          remaining: sql<string>`sum(${creditGrants.microsRemaining})`,
        })
        .from(creditGrants)
        .where(
          and(
            eq(creditGrants.kind, "allowance"),
            eq(creditGrants.status, "active"),
            lte(creditGrants.periodStart, now),
            gt(creditGrants.periodEnd, now)
          )
        )
        .groupBy(creditGrants.userId),
      db
        .select({ userId: speechUsage.userId, kind: speechUsage.kind, v: sql<string>`sum(${speechUsage.seconds})` })
        .from(speechUsage)
        .where(gte(speechUsage.createdAt, monthStart))
        .groupBy(speechUsage.userId, speechUsage.kind),
      db
        .select({ userId: planMeterUsage.userId, v: planMeterUsage.used })
        .from(planMeterUsage)
        .where(and(eq(planMeterUsage.meter, "hosted_enrichment"), eq(planMeterUsage.periodKey, meterPeriodKey(now)))),
      db
        .select({ userId: contacts.userId, v: count() })
        .from(contacts)
        .where(notTourExample(contacts.source))
        .groupBy(contacts.userId),
      // Trends. Credit grants are never deleted; a grant counts in the month its cycle began.
      db.execute(sql`
        SELECT to_char(period_start AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
               sum(micros_granted - micros_remaining) AS used
        FROM credit_grants
        WHERE kind = 'allowance' AND period_start >= ${trendStart} AND ${notInternal(sql`user_id`)}
        GROUP BY 1`),
      db.execute(sql`
        SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month, kind, sum(seconds) AS used
        FROM speech_usage
        WHERE created_at >= ${trendStart} AND ${notInternal(sql`user_id`)}
        GROUP BY 1, 2`),
      db.execute(sql`
        SELECT period_key AS month, sum(used) AS used
        FROM plan_meter_usage
        WHERE meter = 'hosted_enrichment' AND period_key >= ${meterPeriodKey(trendStart)}
          AND ${notInternal(sql`user_id`)}
        GROUP BY 1`),
      // Contacts are a stock, so the trend is contacts ADDED each month.
      db.execute(sql`
        SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month, count(*) AS used
        FROM contacts
        WHERE created_at >= ${trendStart} AND ${notTourExample(sql`source`)}
          AND ${notInternal(sql`user_id`)}
        GROUP BY 1`),
      // Cosmo: connected to ended (or last heartbeat), never past the call's expiry.
      db.execute(sql`
        SELECT user_id AS "userId", sum(${TALKED}) AS v
        FROM orbit_voice_sessions
        WHERE connected_at >= ${monthStart}
        GROUP BY 1`),
      db.execute(sql`
        SELECT to_char(connected_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month, sum(${TALKED}) AS used
        FROM orbit_voice_sessions
        WHERE connected_at >= ${trendStart} AND ${notInternal(sql`user_id`)}
        GROUP BY 1`),
    ]);

  const readings: UsageReadings = {
    credits: new Map(
      grants.flatMap((g) => (g.userId ? [[g.userId, { granted: num(g.granted), remaining: num(g.remaining) }]] : []))
    ),
    meeting: byUser(speech.filter((s) => s.kind === "meeting")),
    shortform: byUser(speech.filter((s) => s.kind === "shortform")),
    assistant: byUser(rowsOf<{ userId: string; v: string }>(talk)),
    enrichment: byUser(meters),
    contacts: byUser(contactCounts),
  };
  const rows = accountUsage(
    accounts.map((a) => ({ userId: a.userId, plan: resolvePlan(a as BillingColumns, now).plan })),
    readings,
    config
  );

  // Twelve month buckets, oldest first, zero until a row fills them.
  const trend: UsageTrendPoint[] = Array.from({ length: 12 }, (_, i) => ({
    month: meterPeriodKey(new Date(Date.UTC(trendStart.getUTCFullYear(), trendStart.getUTCMonth() + i, 1))),
    credits: 0,
    meeting: 0,
    shortform: 0,
    assistant: 0,
    enrichment: 0,
    contacts: 0,
  }));
  const at = (month: unknown) => trend.find((t) => t.month === String(month));
  for (const r of rowsOf<{ month: string; used: string }>(creditTrend)) {
    const p = at(r.month);
    if (p) p.credits = num(r.used) / MICROS_PER_CREDIT;
  }
  for (const r of rowsOf<{ month: string; kind: string; used: string }>(speechTrend)) {
    const p = at(r.month);
    if (p && (r.kind === "meeting" || r.kind === "shortform")) p[r.kind] = num(r.used);
  }
  for (const r of rowsOf<{ month: string; used: string }>(talkTrend)) {
    const p = at(r.month);
    if (p) p.assistant = num(r.used);
  }
  for (const r of rowsOf<{ month: string; used: string }>(meterTrend)) {
    const p = at(r.month);
    if (p) p.enrichment = num(r.used);
  }
  for (const r of rowsOf<{ month: string; used: string }>(contactTrend)) {
    const p = at(r.month);
    if (p) p.contacts = num(r.used);
  }

  return { rows, totals: totalsByPlan(rows), trend, monthStart };
}
