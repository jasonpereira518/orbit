import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { ACTIVATION_WINDOW_DAYS, activatedSql, intentionalActionsSince } from "@/lib/activity";
import { managedCostSql } from "@/lib/ai-access";
import { internalAccountSql } from "@/lib/analytics-internal";
import { signupChannelSql } from "@/lib/attribution";
import { speechSpendMicros } from "@/lib/speech-credit";

/**
 * The metrics the three dashboards and the weekly digest share, defined once.
 *
 * Every figure is a COUNT with its denominator, never a bare percentage: at the account
 * numbers Orbit has, a share of a dozen is not a finding, and `formatRate` (format-rate.ts)
 * already withholds the percentage under thirty. Definitions are in TRACKING_PLAN.md §2; the
 * two that matter most are in `activity.ts` (active, activated). Every account count excludes
 * internal and tester accounts.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const real = (col: string) => sql`NOT ${internalAccountSql(sql.raw(col))}`;

/**
 * Where an account came from, first touch. The one definition lives in `attribution.ts`
 * (`signupChannelSql`), shared with the paid-by-channel reader, so the two cannot drift.
 */
export const CHANNEL_SQL = signupChannelSql("s");

/* ------------------------------------------------------------- north star -------- */

export type Wan = { current: number; previous: number; mau: number };

/**
 * Weekly Active Networkers: distinct accounts with a deliberate action in the trailing seven
 * days, against the seven before, and the month for the stickiness ratio.
 */
export async function weeklyActiveNetworkers(now: Date = new Date()): Promise<Wan> {
  const db = await getDb();
  const res = await db.execute(sql`
    WITH w AS (${intentionalActionsSince(sql`${ago(now, 30)}::timestamptz`)})
    SELECT
      count(DISTINCT user_id) FILTER (WHERE created_at >= ${ago(now, 7)})::int AS current,
      count(DISTINCT user_id) FILTER (WHERE created_at >= ${ago(now, 14)} AND created_at < ${ago(now, 7)})::int AS previous,
      count(DISTINCT user_id)::int AS mau
    FROM w
  `);
  const r = rowsOf<Record<string, number>>(res)[0] ?? {};
  return { current: num(r.current), previous: num(r.previous), mau: num(r.mau) };
}

/* ------------------------------------------------------------- cohorts ---------- */

export type CohortCount = { size: number; activated: number };

/**
 * Accounts created between `olderDays` and `newerDays` ago, and how many activated. Judge a
 * cohort only once `newerDays >= ACTIVATION_WINDOW_DAYS`: younger accounts have not had the
 * whole window and read as misses they are not.
 */
export async function cohortActivation(now: Date, olderDays: number, newerDays: number): Promise<CohortCount> {
  const db = await getDb();
  const res = await db.execute(sql`
    SELECT count(*)::int AS size,
           count(*) FILTER (WHERE ${activatedSql(sql`s.user_id`, sql`s.created_at`)})::int AS activated
    FROM user_settings s
    WHERE s.created_at >= ${ago(now, olderDays)} AND s.created_at < ${ago(now, newerDays)}
      AND ${real("s.user_id")}
  `);
  const r = rowsOf<Record<string, number>>(res)[0] ?? {};
  return { size: num(r.size), activated: num(r.activated) };
}

/**
 * Week-2 return: of accounts that have been around at least fourteen days, how many did
 * something deliberate between day 7 and day 14. The one retention number the wave gate reads.
 */
export async function week2Return(now: Date, olderDays = 28, newerDays = 14): Promise<CohortCount> {
  const db = await getDb();
  const res = await db.execute(sql`
    SELECT count(*)::int AS size,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM (${intentionalActionsSince(sql`s.created_at + interval '7 days'`)}) w
             WHERE w.user_id = s.user_id AND w.created_at < s.created_at + interval '14 days'
           ))::int AS activated
    FROM user_settings s
    WHERE s.created_at >= ${ago(now, olderDays)} AND s.created_at < ${ago(now, newerDays)}
      AND ${real("s.user_id")}
  `);
  const r = rowsOf<Record<string, number>>(res)[0] ?? {};
  return { size: num(r.size), activated: num(r.activated) };
}

export type ChannelRow = { channel: string; signups: number; matured: number; activated: number };

/** Sign-ups, and activation of those old enough to judge, by first-touch channel. */
export async function channelBreakdown(now: Date, windowDays: number): Promise<ChannelRow[]> {
  const db = await getDb();
  const res = await db.execute(sql`
    SELECT ${CHANNEL_SQL} AS channel,
           count(*)::int AS signups,
           count(*) FILTER (WHERE s.created_at < ${ago(now, ACTIVATION_WINDOW_DAYS)})::int AS matured,
           count(*) FILTER (WHERE s.created_at < ${ago(now, ACTIVATION_WINDOW_DAYS)}
                              AND ${activatedSql(sql`s.user_id`, sql`s.created_at`)})::int AS activated
    FROM user_settings s
    WHERE s.created_at >= ${ago(now, windowDays)} AND ${real("s.user_id")}
    GROUP BY 1
    ORDER BY signups DESC
    LIMIT 12
  `);
  return rowsOf<Record<string, string | number>>(res).map((r) => ({
    channel: String(r.channel),
    signups: num(r.signups),
    matured: num(r.matured),
    activated: num(r.activated),
  }));
}

export type PathRow = { path: string; accounts: number; matured: number; activated: number };

/** Activation by the onboarding path chosen (capture, import, tour), over a rolling window. */
export async function pathBreakdown(now: Date, windowDays = 28): Promise<PathRow[]> {
  const db = await getDb();
  const res = await db.execute(sql`
    SELECT coalesce(s.onboarding_path, 'not chosen') AS path,
           count(*)::int AS accounts,
           count(*) FILTER (WHERE s.created_at < ${ago(now, ACTIVATION_WINDOW_DAYS)})::int AS matured,
           count(*) FILTER (WHERE s.created_at < ${ago(now, ACTIVATION_WINDOW_DAYS)}
                              AND ${activatedSql(sql`s.user_id`, sql`s.created_at`)})::int AS activated
    FROM user_settings s
    WHERE s.created_at >= ${ago(now, windowDays)} AND ${real("s.user_id")}
    GROUP BY 1
    ORDER BY accounts DESC
  `);
  return rowsOf<Record<string, string | number>>(res).map((r) => ({
    path: String(r.path),
    accounts: num(r.accounts),
    matured: num(r.matured),
    activated: num(r.activated),
  }));
}

export type WaveRow = {
  waveId: string;
  invited: number;
  accepted: number;
  /** Accepted accounts with a personal key or any successful AI call within a day of signing up. */
  aiReady24h: number;
  /** Accepted accounts old enough to judge activation and return, and how many did. */
  matured: number;
  activated: number;
  returnedWeek2: number;
  firstSentAt: Date | null;
};

/**
 * One row per invite wave. The wave is the cohort: invited, let in, set up, activated,
 * back in week two. "Accepted" is from Orbit's own ledger (`site_invites`), not Clerk's.
 */
export async function waveTable(now: Date): Promise<WaveRow[]> {
  const db = await getDb();
  const res = await db.execute(sql`
    WITH inv AS (
      SELECT i.wave_id, i.id, i.accepted_user_id, i.sent_at
      FROM site_invites i
      WHERE i.revoked_at IS NULL AND i.wave_id IS NOT NULL
    ),
    acc AS (
      SELECT inv.wave_id, s.user_id, s.created_at, s.ai_key_added_at
      FROM inv JOIN user_settings s ON s.user_id = inv.accepted_user_id
      WHERE ${real("s.user_id")}
    )
    SELECT inv.wave_id,
           count(DISTINCT inv.id)::int AS invited,
           count(DISTINCT acc.user_id)::int AS accepted,
           min(inv.sent_at) AS first_sent_at,
           count(DISTINCT acc.user_id) FILTER (WHERE
             (acc.ai_key_added_at IS NOT NULL AND acc.ai_key_added_at < acc.created_at + interval '1 day')
             OR EXISTS (SELECT 1 FROM usage_events u WHERE u.user_id = acc.user_id AND u.success = 1
                          AND u.created_at < acc.created_at + interval '1 day')
           )::int AS ai_ready,
           count(DISTINCT acc.user_id) FILTER (WHERE acc.created_at < ${ago(now, 14)})::int AS matured,
           count(DISTINCT acc.user_id) FILTER (WHERE acc.created_at < ${ago(now, 14)}
              AND ${activatedSql(sql`acc.user_id`, sql`acc.created_at`)})::int AS activated,
           count(DISTINCT acc.user_id) FILTER (WHERE acc.created_at < ${ago(now, 14)} AND EXISTS (
              SELECT 1 FROM (${intentionalActionsSince(sql`acc.created_at + interval '7 days'`)}) w
              WHERE w.user_id = acc.user_id AND w.created_at < acc.created_at + interval '14 days'
           ))::int AS returned
    FROM inv LEFT JOIN acc ON acc.wave_id = inv.wave_id
    GROUP BY inv.wave_id
    ORDER BY min(inv.sent_at)
  `);
  return rowsOf<Record<string, string | number | Date | null>>(res).map((r) => ({
    waveId: String(r.wave_id),
    invited: num(r.invited),
    accepted: num(r.accepted),
    aiReady24h: num(r.ai_ready),
    matured: num(r.matured),
    activated: num(r.activated),
    returnedWeek2: num(r.returned),
    firstSentAt: r.first_sent_at ? new Date(String(r.first_sent_at)) : null,
  }));
}

/** Accounts at least a day old with neither a personal key nor a single successful AI call. */
export async function aiFirstCliff(now: Date): Promise<{ stuck: number; eligible: number }> {
  const db = await getDb();
  const res = await db.execute(sql`
    SELECT count(*)::int AS eligible,
           count(*) FILTER (WHERE s.ai_key_added_at IS NULL AND NOT EXISTS (
             SELECT 1 FROM usage_events u WHERE u.user_id = s.user_id AND u.success = 1
           ))::int AS stuck
    FROM user_settings s
    WHERE s.created_at < ${ago(now, 1)} AND s.created_at >= ${ago(now, 28)} AND ${real("s.user_id")}
  `);
  const r = rowsOf<Record<string, number>>(res)[0] ?? {};
  return { stuck: num(r.stuck), eligible: num(r.eligible) };
}

/* ------------------------------------------------------------- quality ---------- */

export type FailureSummary = {
  accounts: number;
  flows: Array<{ flow: string; accounts: number; failures: number }>;
};

/**
 * Accounts that hit at least one failure they could see, by flow, in the window. Cancelled AI
 * calls are the person's own doing and are left out.
 */
export async function failuresTouchingUsers(now: Date, days = 7): Promise<FailureSummary> {
  const db = await getDb();
  const since = ago(now, days);
  const res = await db.execute(sql`
    WITH f AS (
      SELECT 'capture' AS flow, user_id FROM capture_jobs WHERE status = 'failed' AND created_at >= ${since}
      UNION ALL SELECT 'import', user_id FROM imports WHERE status = 'failed' AND created_at >= ${since}
      UNION ALL SELECT 'email', user_id FROM email_sends WHERE status = 'failed' AND created_at >= ${since}
      UNION ALL SELECT 'ai', user_id FROM usage_events
        WHERE success = 0 AND created_at >= ${since} AND coalesce(error_kind, '') <> 'cancelled'
    )
    SELECT flow, count(DISTINCT user_id)::int AS accounts, count(*)::int AS failures
    FROM f WHERE ${real("user_id")}
    GROUP BY flow
  `);
  const flows = rowsOf<Record<string, string | number>>(res).map((r) => ({
    flow: String(r.flow),
    accounts: num(r.accounts),
    failures: num(r.failures),
  }));
  const total = await db.execute(sql`
    SELECT count(DISTINCT user_id)::int AS n FROM (
      SELECT user_id FROM capture_jobs WHERE status = 'failed' AND created_at >= ${since}
      UNION ALL SELECT user_id FROM imports WHERE status = 'failed' AND created_at >= ${since}
      UNION ALL SELECT user_id FROM email_sends WHERE status = 'failed' AND created_at >= ${since}
      UNION ALL SELECT user_id FROM usage_events WHERE success = 0 AND created_at >= ${since} AND coalesce(error_kind, '') <> 'cancelled'
    ) x WHERE ${real("user_id")}
  `);
  return { accounts: num(rowsOf<{ n: number }>(total)[0]?.n), flows };
}

export type FeedbackCounts = { byCategory: Array<{ category: string; count: number }>; unresolved: number };

export async function feedbackCounts(now: Date, days = 7): Promise<FeedbackCounts> {
  const db = await getDb();
  const [by, open] = await Promise.all([
    db.execute(sql`
      SELECT coalesce(category, 'uncategorised') AS category, count(*)::int AS count
      FROM feedback WHERE created_at >= ${ago(now, days)} GROUP BY 1 ORDER BY count DESC
    `),
    db.execute(sql`SELECT count(*)::int AS n FROM feedback WHERE status <> 'resolved'`),
  ]);
  return {
    byCategory: rowsOf<Record<string, string | number>>(by).map((r) => ({ category: String(r.category), count: num(r.count) })),
    unresolved: num(rowsOf<{ n: number }>(open)[0]?.n),
  };
}

/* ------------------------------------------------------------- money & cost ----- */

export type GateConversion = {
  hits: number;
  accounts: number;
  /** Accounts that paid within seven days of their first refusal in the window. */
  converted: number;
  byFeature: Array<{ feature: string; accounts: number; converted: number }>;
};

/**
 * Refusals, and what became of the accounts that met them. A conversion is a subscription or a
 * Lifetime purchase within seven days of the account's first refusal on that feature.
 */
export async function gateConversion(now: Date, days = 28): Promise<GateConversion> {
  const db = await getDb();
  const res = await db.execute(sql`
    WITH first_hit AS (
      SELECT g.user_id, g.feature, min(g.created_at) AS at, count(*)::int AS hits
      FROM gate_events g
      WHERE g.created_at >= ${ago(now, days)} AND ${real("g.user_id")}
      GROUP BY g.user_id, g.feature
    ),
    scored AS (
      SELECT f.*, EXISTS (
        SELECT 1 FROM billing_events b
        WHERE b.user_id = f.user_id
          AND (b.mrr_delta_cents > 0 OR b.kind = 'lifetime')
          AND b.effective_at >= f.at AND b.effective_at < f.at + interval '7 days'
      ) AS converted
      FROM first_hit f
    )
    SELECT feature, count(*)::int AS accounts, sum(hits)::int AS hits,
           count(*) FILTER (WHERE converted)::int AS converted
    FROM scored GROUP BY feature ORDER BY accounts DESC
  `);
  const rows = rowsOf<Record<string, string | number>>(res);
  const distinct = await db.execute(sql`
    SELECT count(DISTINCT g.user_id)::int AS accounts,
           count(DISTINCT g.user_id) FILTER (WHERE EXISTS (
             SELECT 1 FROM billing_events b
             WHERE b.user_id = g.user_id AND (b.mrr_delta_cents > 0 OR b.kind = 'lifetime')
               AND b.effective_at >= g.created_at AND b.effective_at < g.created_at + interval '7 days'
           ))::int AS converted
    FROM gate_events g WHERE g.created_at >= ${ago(now, days)} AND ${real("g.user_id")}
  `);
  const d = rowsOf<Record<string, number>>(distinct)[0] ?? {};
  return {
    hits: rows.reduce((n, r) => n + num(r.hits), 0),
    accounts: num(d.accounts),
    converted: num(d.converted),
    byFeature: rows.slice(0, 6).map((r) => ({ feature: String(r.feature), accounts: num(r.accounts), converted: num(r.converted) })),
  };
}

/** What Orbit paid in the window for managed AI and Deepgram, in micro-dollars. */
export async function costSince(now: Date, days = 7): Promise<{ aiMicros: number; speechMicros: number }> {
  const db = await getDb();
  const since = ago(now, days);
  const res = await db.execute(sql`
    SELECT coalesce(sum(${managedCostSql()}), 0) AS micros
    FROM usage_events WHERE key_owner = 'orbit' AND created_at >= ${since}
  `);
  return {
    aiMicros: num(rowsOf<{ micros: string | number }>(res)[0]?.micros),
    speechMicros: await speechSpendMicros(new Date(since)),
  };
}

/* ------------------------------------------------------------- the new surfaces -- */

export type ConnectorUse = { connected: number; withCall: number; returning: number; calls: number };

/**
 * MCP or extension use from the product events they write: accounts that connected (or were
 * first seen), made a call/action, and made one in each of the last two weeks.
 */
export async function connectorUse(
  now: Date,
  kind: "mcp" | "extension",
  days = 28
): Promise<ConnectorUse> {
  const db = await getDb();
  const [connectName, callName] = kind === "mcp" ? ["mcp_connected", "mcp_tool_called"] : ["extension_installed", "extension_action"];
  const res = await db.execute(sql`
    WITH e AS (
      SELECT user_id, name, occurred_at FROM product_events
      WHERE occurred_at >= ${ago(now, days)} AND user_id IS NOT NULL AND is_internal = false
    )
    SELECT
      (SELECT count(DISTINCT user_id) FROM e WHERE name = ${connectName})::int AS connected,
      (SELECT count(DISTINCT user_id) FROM e WHERE name = ${callName})::int AS with_call,
      (SELECT count(*) FROM e WHERE name = ${callName})::int AS calls,
      (SELECT count(*) FROM (
         SELECT user_id FROM e WHERE name = ${callName} AND occurred_at >= ${ago(now, 7)}
         INTERSECT
         SELECT user_id FROM e WHERE name = ${callName} AND occurred_at >= ${ago(now, 14)} AND occurred_at < ${ago(now, 7)}
       ) r)::int AS returning
  `);
  const r = rowsOf<Record<string, number>>(res)[0] ?? {};
  return { connected: num(r.connected), withCall: num(r.with_call), returning: num(r.returning), calls: num(r.calls) };
}

/** Alerts open right now, by severity. */
export async function openAlerts(): Promise<{ critical: number; warning: number; info: number }> {
  const db = await getDb();
  const res = await db.execute(sql`
    SELECT count(*) FILTER (WHERE severity = 'critical')::int AS critical,
           count(*) FILTER (WHERE severity = 'warning')::int AS warning,
           count(*) FILTER (WHERE severity = 'info')::int AS info
    FROM ops_alert_state WHERE active = true
  `);
  const r = rowsOf<Record<string, number>>(res)[0] ?? {};
  return { critical: num(r.critical), warning: num(r.warning), info: num(r.info) };
}

/* ------------------------------------------------------------- retention pools --- */

export type RetentionPools = {
  /** Ever did something deliberate. The denominator for the rest. */
  everActive: number;
  /** Active this week after at least four quiet weeks that followed earlier activity. */
  resurrected: number;
  /** Last deliberate action 21 to 60 days ago: the seasonal pool, not yet churned. */
  goingCold: number;
  /** Last deliberate action more than 60 days ago. */
  dormant: number;
};

/**
 * Where everyone who ever used Orbit now sits. "Going cold" is the pool a job search leaves
 * behind each season and a win-back message can reach; it is reported as a pool, never as churn.
 * Orbit records no goal type, so there is no job-seeker cut here: that needs a stated goal at
 * onboarding, not a guess from goal text.
 */
export async function retentionPools(now: Date = new Date()): Promise<RetentionPools> {
  const db = await getDb();
  const res = await db.execute(sql`
    WITH w AS (${intentionalActionsSince(sql`${ago(now, 400)}::timestamptz`)}),
    u AS (
      SELECT user_id,
             bool_or(created_at >= ${ago(now, 7)}) AS recent,
             bool_or(created_at >= ${ago(now, 35)} AND created_at < ${ago(now, 7)}) AS mid,
             bool_or(created_at < ${ago(now, 35)}) AS old,
             max(created_at) AS last_at
      FROM w GROUP BY user_id
    )
    SELECT count(*)::int AS ever_active,
           count(*) FILTER (WHERE recent AND NOT mid AND old)::int AS resurrected,
           count(*) FILTER (WHERE last_at < ${ago(now, 21)} AND last_at >= ${ago(now, 60)})::int AS cold,
           count(*) FILTER (WHERE last_at < ${ago(now, 60)})::int AS dormant
    FROM u
  `);
  const r = rowsOf<Record<string, number>>(res)[0] ?? {};
  return { everActive: num(r.ever_active), resurrected: num(r.resurrected), goingCold: num(r.cold), dormant: num(r.dormant) };
}

/* ------------------------------------------------------------- conversion -------- */

export type FreeToPaid = {
  /** Activated accounts old enough (30 days) to have had a fair chance to pay. */
  eligible: number;
  paid: number;
  /** Median days from sign-up to the first paid event, among those who paid. */
  medianDaysToPay: number | null;
};

/**
 * Of accounts that activated and are at least a month old, how many have paid, and how long it
 * took. Paid is a subscription or a Lifetime purchase; comped and internal accounts are not in
 * it. Counts with a denominator: the median is withheld by the caller below five payers.
 */
export async function freeToPaid(now: Date = new Date()): Promise<FreeToPaid> {
  const db = await getDb();
  const res = await db.execute(sql`
    WITH a AS (
      SELECT s.user_id, s.created_at,
             (SELECT min(b.effective_at) FROM billing_events b
                WHERE b.user_id = s.user_id AND (b.mrr_delta_cents > 0 OR b.kind = 'lifetime')) AS first_paid
      FROM user_settings s
      WHERE s.created_at < ${ago(now, 30)} AND s.created_at >= ${ago(now, 180)}
        AND s.comped_plan IS NULL AND ${real("s.user_id")}
        AND ${activatedSql(sql`s.user_id`, sql`s.created_at`)}
    )
    SELECT count(*)::int AS eligible,
           count(*) FILTER (WHERE first_paid IS NOT NULL)::int AS paid,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (first_paid - created_at)) / 86400.0)
             FILTER (WHERE first_paid IS NOT NULL) AS median_days
    FROM a
  `);
  const r = rowsOf<Record<string, string | number | null>>(res)[0] ?? {};
  return {
    eligible: num(r.eligible),
    paid: num(r.paid),
    medianDaysToPay: r.median_days == null ? null : Math.round(num(r.median_days)),
  };
}

export type ChurnSummary = { canceledLast90d: number; subscribersNow: number };

/** Subscriptions that ended in the last 90 days, against the live paying base (comps excluded). */
export async function churnSummary(now: Date = new Date()): Promise<ChurnSummary> {
  const db = await getDb();
  const res = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM billing_events b WHERE b.kind = 'churn' AND b.effective_at >= ${ago(now, 90)}
         AND (b.user_id IS NULL OR ${real("b.user_id")}))::int AS canceled,
      (SELECT count(*) FROM user_settings s
         WHERE s.subscription_plan IN ('orbit', 'max') AND s.comped_plan IS NULL
           AND s.subscription_status IN ('active', 'past_due') AND ${real("s.user_id")})::int AS subscribers
  `);
  const r = rowsOf<Record<string, number>>(res)[0] ?? {};
  return { canceledLast90d: num(r.canceled), subscribersNow: num(r.subscribers) };
}

/** The three newest unresolved bug reports, as ids and areas only; the text stays behind a click. */
export async function newestBugs(limit = 3): Promise<Array<{ id: string; area: string | null; createdAt: Date }>> {
  const db = await getDb();
  const res = await db.execute(sql`
    SELECT id, area, created_at FROM feedback
    WHERE category = 'bug' AND status <> 'resolved'
    ORDER BY created_at DESC LIMIT ${limit}
  `);
  return rowsOf<Record<string, string | Date | null>>(res).map((r) => ({
    id: String(r.id),
    area: r.area ? String(r.area) : null,
    createdAt: new Date(String(r.created_at)),
  }));
}
