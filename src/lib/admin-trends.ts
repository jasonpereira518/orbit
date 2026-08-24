import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { USAGE_EVENT_RETENTION_DAYS } from "@/lib/admin-health";

/**
 * Time-bucketed growth and activation, for `/admin/funnel`.
 *
 * WHY THIS IS NOT ON `/admin`. The overview's rule — "absolute integers only: no
 * percentages, no rates, no trend sparklines" — is right, and stays. It is really three
 * rules, and only the last conflicts with anything here:
 *
 *   No percentages or rates. Kept, on this screen too. One new subscriber is +100% MRR
 *   growth, and retention is reported as "14 signed up, 9 came back", never as 64%.
 *
 *   No vanity totals. Kept. Contacts-across-all-accounts changes no decision and is absent.
 *
 *   No sparklines. This one bends, and only here. It was written against smoothed shapes
 *   with no labels — 0,1,0,0,2,1,0 rendered as a squiggle really is noise given a shape.
 *   The same seven numbers as seven labelled bars is a countable column, which is what
 *   `MiniBars` already does for the activation funnel on the overview.
 *
 * So trends get their own route rather than being smuggled onto the triage screen, and
 * `/admin` keeps answering "is anything on fire" in two seconds.
 *
 * The bucketing is done in SQL against `generate_series` rather than by reducing rows in
 * JS. That is not premature optimisation — it is the only way empty buckets appear as zero
 * instead of vanishing, and a gap that silently closes up is a chart that lies.
 */

export type Grain = "week" | "month";
export type TrendPoint = { bucketStart: Date; count: number };

export type ActivationPoint = {
  bucketStart: Date;
  signed: number;
  onboarded: number;
  firstContact: number;
};

export type RetentionCohort = {
  cohortStart: Date;
  size: number;
  /** Wrote something at least 30 days after signing up. */
  returnedAfter30d: number;
  /** Wrote something in the last 30 days, whenever they joined. */
  activeNow: number;
};

export type FeatureAdoption = {
  chat: number;
  outreach: number;
  recruiters: number;
  calendar: number;
  gmail: number;
  outlook: number;
  imports: number;
  goals: number;
};

function toDate(value: Date | string | null | undefined): Date {
  if (value instanceof Date) return value;
  return new Date(String(value));
}

function num(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Grain is a closed set, never interpolated from a query string. */
function grainInterval(grain: Grain): string {
  return grain === "month" ? "1 month" : "1 week";
}

/**
 * The bucket spine: one row per period, present whether or not anything happened in it.
 *
 * Every trend LEFT JOINs onto this, which is what makes a quiet week render as a zero-height
 * bar rather than disappearing and making the neighbouring weeks look adjacent.
 */
function series(grain: Grain, buckets: number) {
  const step = grainInterval(grain);
  return sql`
    SELECT gs.bucket_start
    FROM generate_series(
      date_trunc(${grain}, now()) - (${sql.raw(`interval '${step}'`)} * ${buckets - 1}),
      date_trunc(${grain}, now()),
      ${sql.raw(`interval '${step}'`)}
    ) AS gs(bucket_start)
  `;
}

export async function signupTrend(
  grain: Grain = "week",
  buckets = 12
): Promise<TrendPoint[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    WITH spine AS (${series(grain, buckets)})
    SELECT spine.bucket_start,
           count(s.user_id)::int AS n
    FROM spine
    LEFT JOIN user_settings s
      ON date_trunc(${grain}, s.created_at) = spine.bucket_start
    GROUP BY spine.bucket_start
    ORDER BY spine.bucket_start
  `);
  return rowsOf<{ bucket_start: string; n: number }>(result).map((r) => ({
    bucketStart: toDate(r.bucket_start),
    count: num(r.n),
  }));
}

/**
 * Distinct accounts that *wrote* something in each period.
 *
 * Counted from writes across five tables rather than from `last_active_at`, which is a
 * throttled stamp of the most recent session and carries no history — it can answer "who is
 * active now" but not "who was active in March". Distinct users, not events: one person
 * with fifty captures in a week is one active account.
 */
export async function activeTrend(
  grain: Grain = "week",
  buckets = 12
): Promise<TrendPoint[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    WITH spine AS (${series(grain, buckets)}),
    writes AS (
      SELECT user_id, created_at FROM contacts
      UNION ALL SELECT user_id, created_at FROM interactions
      UNION ALL SELECT user_id, created_at FROM chat_messages
      UNION ALL SELECT user_id, created_at FROM imports
      UNION ALL SELECT user_id, created_at FROM usage_events
    )
    SELECT spine.bucket_start,
           count(DISTINCT w.user_id)::int AS n
    FROM spine
    LEFT JOIN writes w
      ON date_trunc(${grain}, w.created_at) = spine.bucket_start
    GROUP BY spine.bucket_start
    ORDER BY spine.bucket_start
  `);
  return rowsOf<{ bucket_start: string; n: number }>(result).map((r) => ({
    bucketStart: toDate(r.bucket_start),
    count: num(r.n),
  }));
}

/**
 * Signups against how far each cohort got, by the period they joined in.
 *
 * `onboarded` mirrors `needsOnboarding()`: an account with any contact or import counts as
 * onboarded even when `onboarding_completed_at` is null, because that column is backfilled
 * later. A naive IS NOT NULL check undercounts every account predating the backfill.
 */
export async function activationTrend(
  grain: Grain = "week",
  buckets = 12
): Promise<ActivationPoint[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    WITH spine AS (${series(grain, buckets)}),
    per_user AS (
      SELECT s.user_id,
             date_trunc(${grain}, s.created_at) AS bucket_start,
             s.onboarding_completed_at,
             (SELECT count(*) FROM contacts c WHERE c.user_id = s.user_id) AS contact_count,
             (SELECT count(*) FROM imports i WHERE i.user_id = s.user_id) AS import_count
      FROM user_settings s
    )
    SELECT spine.bucket_start,
           count(p.user_id)::int AS signed,
           coalesce(sum(CASE
             WHEN p.onboarding_completed_at IS NOT NULL
               OR p.contact_count > 0
               OR p.import_count > 0
             THEN 1 ELSE 0 END), 0)::int AS onboarded,
           coalesce(sum(CASE WHEN p.contact_count > 0 THEN 1 ELSE 0 END), 0)::int AS first_contact
    FROM spine
    LEFT JOIN per_user p ON p.bucket_start = spine.bucket_start
    GROUP BY spine.bucket_start
    ORDER BY spine.bucket_start
  `);
  return rowsOf<{
    bucket_start: string;
    signed: number;
    onboarded: number;
    first_contact: number;
  }>(result).map((r) => ({
    bucketStart: toDate(r.bucket_start),
    signed: num(r.signed),
    onboarded: num(r.onboarded),
    firstContact: num(r.first_contact),
  }));
}

/**
 * Did each month's intake stick around?
 *
 * Reported as three integers per cohort, never as a percentage grid. At this scale a
 * retention percentage is a number with one or two people behind it, and rendering it as
 * "64%" invites a confidence the sample cannot carry.
 */
export async function retentionCohorts(months = 6): Promise<RetentionCohort[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    WITH spine AS (
      SELECT gs.bucket_start
      FROM generate_series(
        date_trunc('month', now()) - (interval '1 month' * ${months - 1}),
        date_trunc('month', now()),
        interval '1 month'
      ) AS gs(bucket_start)
    ),
    writes AS (
      SELECT user_id, created_at FROM contacts
      UNION ALL SELECT user_id, created_at FROM interactions
      UNION ALL SELECT user_id, created_at FROM chat_messages
      UNION ALL SELECT user_id, created_at FROM imports
      UNION ALL SELECT user_id, created_at FROM usage_events
    ),
    per_user AS (
      SELECT s.user_id,
             date_trunc('month', s.created_at) AS cohort_start,
             s.created_at AS signed_at,
             (SELECT max(w.created_at) FROM writes w WHERE w.user_id = s.user_id) AS last_write
      FROM user_settings s
    )
    SELECT spine.bucket_start,
           count(p.user_id)::int AS size,
           coalesce(sum(CASE
             WHEN p.last_write > p.signed_at + interval '30 days'
             THEN 1 ELSE 0 END), 0)::int AS returned_after_30d,
           coalesce(sum(CASE
             WHEN p.last_write > now() - interval '30 days'
             THEN 1 ELSE 0 END), 0)::int AS active_now
    FROM spine
    LEFT JOIN per_user p ON p.cohort_start = spine.bucket_start
    GROUP BY spine.bucket_start
    ORDER BY spine.bucket_start
  `);
  return rowsOf<{
    bucket_start: string;
    size: number;
    returned_after_30d: number;
    active_now: number;
  }>(result).map((r) => ({
    cohortStart: toDate(r.bucket_start),
    size: num(r.size),
    returnedAfter30d: num(r.returned_after_30d),
    activeNow: num(r.active_now),
  }));
}

/**
 * How many accounts have ever touched each feature.
 *
 * The question this answers is which parts of Orbit are load-bearing and which are
 * decoration — the one cross-account total that does change a decision, unlike "contacts
 * across all accounts".
 */
export async function featureAdoption(): Promise<FeatureAdoption> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT
      (SELECT count(DISTINCT user_id) FROM chat_messages)          AS chat,
      (SELECT count(DISTINCT user_id) FROM outreach_campaigns)     AS outreach,
      (SELECT count(DISTINCT user_id) FROM user_recruiter_links)   AS recruiters,
      (SELECT count(DISTINCT user_id) FROM calendar_subscriptions) AS calendar,
      (SELECT count(DISTINCT user_id) FROM gmail_connections)      AS gmail,
      (SELECT count(DISTINCT user_id) FROM outlook_connections)    AS outlook,
      (SELECT count(DISTINCT user_id) FROM imports)                AS imports,
      (SELECT count(DISTINCT user_id) FROM user_goals)             AS goals
  `);
  const row = rowsOf<Record<string, string | number>>(result)[0] ?? {};
  return {
    chat: num(row.chat),
    outreach: num(row.outreach),
    recruiters: num(row.recruiters),
    calendar: num(row.calendar),
    gmail: num(row.gmail),
    outlook: num(row.outlook),
    imports: num(row.imports),
    goals: num(row.goals),
  };
}

/** AI calls and failures per period. Capped at the retention window; older rows are pruned. */
export async function aiVolumeTrend(
  grain: Grain = "week",
  buckets = 12
): Promise<Array<TrendPoint & { failures: number }>> {
  const maxBuckets =
    grain === "month"
      ? Math.floor(USAGE_EVENT_RETENTION_DAYS / 30)
      : Math.floor(USAGE_EVENT_RETENTION_DAYS / 7);
  const bounded = Math.min(buckets, Math.max(maxBuckets, 1));

  const db = await getDb();
  const result = await db.execute(sql`
    WITH spine AS (${series(grain, bounded)})
    SELECT spine.bucket_start,
           count(u.id)::int AS n,
           coalesce(sum(CASE WHEN u.success = 0 THEN 1 ELSE 0 END), 0)::int AS failures
    FROM spine
    LEFT JOIN usage_events u
      ON date_trunc(${grain}, u.created_at) = spine.bucket_start
    GROUP BY spine.bucket_start
    ORDER BY spine.bucket_start
  `);
  return rowsOf<{ bucket_start: string; n: number; failures: number }>(result).map(
    (r) => ({
      bucketStart: toDate(r.bucket_start),
      count: num(r.n),
      failures: num(r.failures),
    })
  );
}
