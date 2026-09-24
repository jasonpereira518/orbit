import { sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { USAGE_EVENT_RETENTION_DAYS } from "@/lib/admin-health";

/**
 * Time-bucketed growth and activation, for `/admin/growth`.
 *
 * WHY THIS IS NOT ON `/admin`. The overview's rule — "absolute integers only: no
 * percentages, no rates, no trend sparklines" — is right, and stays. It is really three
 * rules, and only the last conflicts with anything here:
 *
 *   No percentages or rates. Kept, with one bounded exception. Axes, labels and tiles are
 *   counts — retention reads "9 of 14", never 64%. A percentage appears only in a chart's
 *   hover readout, beside its fraction, and only once the denominator reaches
 *   `MIN_RATE_DENOMINATOR` (`format-rate.ts`) — the same compromise the Conversion page
 *   made. Below that, a percentage is two people wearing a confidence interval.
 *
 *   No vanity totals. Kept. Contacts-across-all-accounts changes no decision and is absent.
 *   Total accounts is not a vanity total: it is the one line the page exists to draw.
 *
 *   No sparklines. This one bends, and only here. It was written against smoothed shapes
 *   with no labels — 0,1,0,0,2,1,0 rendered as a squiggle really is noise given a shape.
 *   The charts in `growth-charts.tsx` answer it the way `charts.tsx` does: a zero-anchored
 *   axis that never autoscales to the data range, and every value reachable without
 *   hovering through the table toggle each chart carries.
 *
 * So trends get their own route rather than being smuggled onto the triage screen, and
 * `/admin` keeps answering "is anything on fire" in two seconds.
 *
 * The bucketing is done in SQL against `generate_series` rather than by reducing rows in
 * JS. That is not premature optimisation — it is the only way empty buckets appear as zero
 * instead of vanishing, and a gap that silently closes up is a chart that lies.
 */

/**
 * `"day"` exists for the traffic page, which reports on a scale where a week is already
 * a summary. Widening this rather than forking `series()` — a second copy of the
 * gap-filling spine is a second chance to get an empty bucket wrong.
 */
export type Grain = "day" | "week" | "month";
export type TrendPoint = { bucketStart: Date; count: number };

export type ActivationPoint = {
  bucketStart: Date;
  signed: number;
  onboarded: number;
  firstContact: number;
};

export type UserTotalsPoint = { bucketStart: Date; added: number; total: number };

export type ViewersPoint = { bucketStart: Date; viewers: number; views: number };

export type RollingActivePoint = {
  bucketStart: Date;
  dau: number;
  wau: number;
  mau: number;
};

export type GrowthSnapshot = {
  total: number;
  newNow: number;
  newPrev: number;
  dau: number;
  dauPrev: number;
  wau: number;
  wauPrev: number;
  mau: number;
  mauPrev: number;
};

export type RetentionCurve = {
  cohortStart: Date;
  size: number;
  /** Only weeks every member has lived through; a young cohort has a short list. */
  weeks: Array<{ week: number; active: number }>;
};

export type DepthPoint = {
  bucketStart: Date;
  /** Distinct accounts that wrote anything — the denominator. */
  active: number;
  captures: number;
  notes: number;
  chats: number;
  imports: number;
};

export type WorkflowStagePoint = {
  bucketStart: Date;
  signedUp: number;
  onboarded: number;
  hasContacts: number;
  loggedActivity: number;
  cameBack: number;
};

export type ConsistencyPoint = {
  bucketStart: Date;
  active: number;
  threeOfFour: number;
  allFour: number;
};

export type AiWeekPoint = {
  bucketStart: Date;
  calls: number;
  failures: number;
  orbitMicros: number;
  userMicros: number;
  /** Calls on a model with no known price — not free, just unpriced. */
  unpriced: number;
};

export type AiOperationCostRow = {
  operation: string;
  calls: number;
  users: number;
  failures: number;
  micros: number;
  orbitMicros: number;
};

/** One row of the Growth page's "Accounts that have used each feature" bars. */
export type FeatureAdoptionRow = { key: FeatureKey; label: string; count: number };

/**
 * The product's core features, and the table whose rows prove an account used it.
 * Deliberately short: connectors (Gmail, Outlook, iCloud), the API/MCP surface, phone
 * scanning and Recruiters are left off to keep the chart about the main loop. A feature
 * behind a coming-soon screen (Outreach, Events) is left out too: nobody can use it, so
 * its bar would only ever measure the operator's own testing. The query and the labels
 * are both built from this list.
 */
const FEATURES = [
  { key: "capture", label: "Capture", table: "capture_jobs" },
  { key: "chat", label: "Chat", table: "chat_messages" },
  { key: "meetings", label: "Meetings", table: "meeting_sessions" },
  { key: "reminders", label: "Reminders", table: "reminders" },
  { key: "imports", label: "Imports", table: "imports" },
  { key: "goals", label: "Goals", table: "user_goals" },
  { key: "extension", label: "Extension", table: "extension_usage" },
] as const;

type FeatureKey = (typeof FEATURES)[number]["key"] | "calendar";

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
  if (grain === "month") return "1 month";
  return grain === "day" ? "1 day" : "1 week";
}

/**
 * The bucket spine: one row per period, present whether or not anything happened in it.
 *
 * Every trend LEFT JOINs onto this, which is what makes a quiet week render as a zero-height
 * bar rather than disappearing and making the neighbouring weeks look adjacent.
 *
 * Exported for `money-metrics.ts`. A second copy of this would be a second chance to get
 * the gap-filling wrong, and a money chart that silently closes up an empty month is
 * worse than one that fails to draw.
 */
export function series(grain: Grain, buckets: number) {
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

/**
 * What counts as "did something": a row written to any of these five tables.
 *
 * One fragment, shared by every activity query below, so the active-accounts chart, the
 * retention curves and the depth denominator can never disagree about who was active.
 * Counted from writes rather than from `last_active_at`, which is a throttled stamp of the
 * most recent session and carries no history — it can answer "who is active now" but not
 * "who was active in March".
 *
 * Takes a lower bound so each query scans only the window it draws, not every row ever.
 */
function writesSince(since: SQL) {
  return sql`
    SELECT user_id, created_at FROM contacts WHERE created_at >= ${since}
    UNION ALL SELECT user_id, created_at FROM interactions WHERE created_at >= ${since}
    UNION ALL SELECT user_id, created_at FROM chat_messages WHERE created_at >= ${since}
    UNION ALL SELECT user_id, created_at FROM imports WHERE created_at >= ${since}
    UNION ALL SELECT user_id, created_at FROM usage_events WHERE created_at >= ${since}
  `;
}

/** The first bucket on a spine CTE named `spine` — the lower bound every query scans from. */
const SPINE_START = sql`(SELECT min(bucket_start) FROM spine)`;

/** The earliest signup, which is where the "All time" range starts. */
export async function firstSignupAt(): Promise<Date | null> {
  const db = await getDb();
  const result = await db.execute(sql`SELECT min(created_at) AS first FROM user_settings`);
  const first = rowsOf<{ first: string | null }>(result)[0]?.first;
  return first ? toDate(first) : null;
}

/**
 * New accounts per period, and the running total they add up to.
 *
 * The total is seeded with every account created before the window, so the line starts
 * where the product actually was rather than at zero. It counts accounts that still exist:
 * a deleted account is purged along with its settings row, so history can only ever show
 * survivors, and the page says so beside the chart.
 */
export async function userTotalsTrend(
  grain: Grain = "week",
  buckets = 12
): Promise<UserTotalsPoint[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    WITH spine AS (${series(grain, buckets)}),
    before_window AS (
      SELECT count(*)::int AS n FROM user_settings WHERE created_at < ${SPINE_START}
    )
    SELECT spine.bucket_start,
           count(s.user_id)::int AS added,
           ((SELECT n FROM before_window)
             + sum(count(s.user_id)) OVER (ORDER BY spine.bucket_start))::int AS total
    FROM spine
    LEFT JOIN user_settings s
      ON date_trunc(${grain}, s.created_at) = spine.bucket_start
    GROUP BY spine.bucket_start
    ORDER BY spine.bucket_start
  `);
  return rowsOf<{ bucket_start: string; added: number; total: number }>(result).map(
    (r) => ({
      bucketStart: toDate(r.bucket_start),
      added: num(r.added),
      total: num(r.total),
    })
  );
}

/**
 * Signed-in accounts that opened Orbit, per period — the "looked" half of engagement.
 *
 * Read from `page_views`, which records `user_id` on signed-in views. This is the measure
 * that sees the person who opens their network every morning and edits nothing, who is
 * invisible to the write-based active count. Bots are excluded the same way the traffic
 * page excludes them; anonymous views have no account and are not counted.
 */
export async function viewersTrend(
  grain: Grain = "week",
  buckets = 12
): Promise<ViewersPoint[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    WITH spine AS (${series(grain, buckets)}),
    v AS (
      SELECT user_id, created_at
      FROM page_views
      WHERE is_bot = false
        AND user_id IS NOT NULL
        AND created_at >= ${SPINE_START}
    )
    SELECT spine.bucket_start,
           count(DISTINCT v.user_id)::int AS viewers,
           count(v.user_id)::int AS views
    FROM spine
    LEFT JOIN v ON date_trunc(${grain}, v.created_at) = spine.bucket_start
    GROUP BY spine.bucket_start
    ORDER BY spine.bucket_start
  `);
  return rowsOf<{ bucket_start: string; viewers: number; views: number }>(result).map(
    (r) => ({
      bucketStart: toDate(r.bucket_start),
      viewers: num(r.viewers),
      views: num(r.views),
    })
  );
}

/**
 * Daily, weekly and monthly active accounts, measured at the end of each period.
 *
 * Each point looks back from the bucket's close (or from now, for the bucket still in
 * progress) over trailing 1, 7 and 30 days. Trailing windows rather than calendar ones, so
 * the three lines share one definition and DAU ≤ WAU ≤ MAU holds at every point — the
 * smoke suite asserts it.
 */
export async function rollingActiveTrend(
  grain: Grain = "week",
  buckets = 12
): Promise<RollingActivePoint[]> {
  const step = grainInterval(grain);
  const db = await getDb();
  const result = await db.execute(sql`
    WITH spine AS (${series(grain, buckets)}),
    points AS (
      SELECT bucket_start,
             least(bucket_start + ${sql.raw(`interval '${step}'`)}, now()) AS as_of
      FROM spine
    ),
    w AS (${writesSince(sql`${SPINE_START} - interval '30 days'`)})
    SELECT p.bucket_start,
           count(DISTINCT w.user_id)
             FILTER (WHERE w.created_at >= p.as_of - interval '1 day')::int AS dau,
           count(DISTINCT w.user_id)
             FILTER (WHERE w.created_at >= p.as_of - interval '7 days')::int AS wau,
           count(DISTINCT w.user_id)::int AS mau
    FROM points p
    LEFT JOIN w
      ON w.created_at >= p.as_of - interval '30 days'
     AND w.created_at < p.as_of
    GROUP BY p.bucket_start
    ORDER BY p.bucket_start
  `);
  return rowsOf<{ bucket_start: string; dau: number; wau: number; mau: number }>(
    result
  ).map((r) => ({
    bucketStart: toDate(r.bucket_start),
    dau: num(r.dau),
    wau: num(r.wau),
    mau: num(r.mau),
  }));
}

/**
 * The headline row: where things stand now, against the period just before.
 *
 * Every comparison is a pair of counts, never a growth rate. `newInRange` is compared with
 * the equal-length window before it; each active measure with its own trailing window one
 * length earlier (today against yesterday, this week against last week).
 */
export async function growthSnapshot(spanDays: number): Promise<GrowthSnapshot> {
  const span = sql.raw(`interval '${Math.max(1, Math.round(spanDays))} days'`);
  const db = await getDb();
  const result = await db.execute(sql`
    WITH w AS (${writesSince(sql`now() - interval '60 days'`)})
    SELECT
      (SELECT count(*) FROM user_settings)::int AS total,
      (SELECT count(*) FROM user_settings WHERE created_at >= now() - ${span})::int AS new_now,
      (SELECT count(*) FROM user_settings
        WHERE created_at >= now() - ${span} * 2
          AND created_at < now() - ${span})::int AS new_prev,
      count(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '1 day')::int AS dau,
      count(DISTINCT user_id) FILTER (
        WHERE created_at >= now() - interval '2 days'
          AND created_at < now() - interval '1 day')::int AS dau_prev,
      count(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '7 days')::int AS wau,
      count(DISTINCT user_id) FILTER (
        WHERE created_at >= now() - interval '14 days'
          AND created_at < now() - interval '7 days')::int AS wau_prev,
      count(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '30 days')::int AS mau,
      count(DISTINCT user_id) FILTER (
        WHERE created_at < now() - interval '30 days')::int AS mau_prev
    FROM w
  `);
  const r = rowsOf<Record<string, number | string>>(result)[0] ?? {};
  return {
    total: num(r.total),
    newNow: num(r.new_now),
    newPrev: num(r.new_prev),
    dau: num(r.dau),
    dauPrev: num(r.dau_prev),
    wau: num(r.wau),
    wauPrev: num(r.wau_prev),
    mau: num(r.mau),
    mauPrev: num(r.mau_prev),
  };
}

/**
 * How many of each month's signups were still active N weeks after they joined.
 *
 * Week N for an account is the seven days starting N weeks after its own signup, so a
 * cohort is aligned on each member's first day rather than on the calendar.
 *
 * A point is reported only once EVERY member of the cohort has lived through that week.
 * Plotting a partial week would show the newest cohort "dropping off" when its later
 * joiners simply have not reached week 3 yet — the steepest fall on the chart would be an
 * artefact of the calendar. So a young cohort draws a short line, and that is correct.
 *
 * Counts, not rates: the tooltip adds a percentage only once the cohort is large enough
 * (`formatRate`). Cohort sizes are returned so the chart can print "5 of 9".
 */
export async function retentionCurves(
  months = 6,
  maxWeeks = 12
): Promise<RetentionCurve[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    WITH cohorts AS (
      SELECT gs.cohort_start
      FROM generate_series(
        date_trunc('month', now()) - (interval '1 month' * ${months - 1}),
        date_trunc('month', now()),
        interval '1 month'
      ) AS gs(cohort_start)
    ),
    members AS (
      SELECT user_id, created_at AS signed_at, date_trunc('month', created_at) AS cohort_start
      FROM user_settings
      WHERE created_at >= (SELECT min(cohort_start) FROM cohorts)
    ),
    -- One row per (account, week it was active in). A write a moment before the settings
    -- row exists (sign-up races the first import) still lands in week 0.
    activity AS (
      SELECT DISTINCT m.user_id,
             greatest(0, floor(extract(epoch FROM (w.created_at - m.signed_at)) / 604800))::int AS wk
      FROM members m
      JOIN (${writesSince(sql`(SELECT min(cohort_start) FROM cohorts) - interval '1 day'`)}) w
        ON w.user_id = m.user_id
       AND w.created_at >= m.signed_at - interval '1 day'
    ),
    weeks AS (SELECT generate_series(0, ${maxWeeks}) AS wk)
    SELECT c.cohort_start,
           wk.wk,
           count(m.user_id)::int AS size,
           count(m.user_id)
             FILTER (WHERE m.signed_at + (wk.wk + 1) * interval '7 days' <= now())::int AS elapsed,
           count(a.user_id)::int AS active
    FROM cohorts c
    CROSS JOIN weeks wk
    LEFT JOIN members m ON m.cohort_start = c.cohort_start
    LEFT JOIN activity a ON a.user_id = m.user_id AND a.wk = wk.wk
    GROUP BY c.cohort_start, wk.wk
    ORDER BY c.cohort_start, wk.wk
  `);

  const curves = new Map<string, RetentionCurve>();
  for (const r of rowsOf<{
    cohort_start: string;
    wk: number;
    size: number;
    elapsed: number;
    active: number;
  }>(result)) {
    const start = toDate(r.cohort_start);
    const key = start.toISOString();
    const curve = curves.get(key) ?? { cohortStart: start, size: num(r.size), weeks: [] };
    // Only weeks the whole cohort has finished — see the docstring.
    if (curve.size > 0 && num(r.elapsed) === curve.size) {
      curve.weeks.push({ week: num(r.wk), active: num(r.active) });
    }
    curves.set(key, curve);
  }
  return [...curves.values()];
}

/**
 * What active accounts did, per period: the "how much" behind the active count.
 *
 * Four actions a person takes on purpose, each counted where it cannot overlap another:
 *
 *   Captures: capture jobs that reached `saved`. A capture writes its notes as a batch, so
 *   those interactions are excluded from the next line rather than counted twice.
 *   Notes logged: interactions written by hand — no note batch, and no `external_id`, which
 *   is what calendar sync and LinkedIn message imports stamp. Without that filter one
 *   import of three years of messages is the biggest week in the product's history.
 *   Chat messages: the user's side only; the assistant's reply is not a second action.
 *   Imports: one per import job, however many contacts it brought in.
 *
 * AI calls are left out on purpose: they are a consequence of captures and chat, so
 * stacking them would count one action twice. They are reported on the Health page.
 *
 * `active` is the same distinct-writers count the rest of the page uses, so the chart can
 * divide on the client and still show the raw counts in its tooltip.
 */
export async function depthTrend(
  grain: Grain = "week",
  buckets = 12
): Promise<DepthPoint[]> {
  const db = await getDb();
  const bucketOf = (table: SQL, where: SQL) => sql`
    SELECT date_trunc(${grain}, created_at) AS b, count(*)::int AS n
    FROM ${table}
    WHERE created_at >= ${SPINE_START} AND ${where}
    GROUP BY 1
  `;
  const result = await db.execute(sql`
    WITH spine AS (${series(grain, buckets)}),
    captures AS (${bucketOf(sql`capture_jobs`, sql`status = 'saved'`)}),
    notes AS (${bucketOf(
      sql`interactions`,
      sql`note_batch_id IS NULL AND external_id IS NULL`
    )}),
    chats AS (${bucketOf(sql`chat_messages`, sql`role = 'user'`)}),
    imps AS (${bucketOf(sql`imports`, sql`true`)}),
    active AS (
      SELECT date_trunc(${grain}, created_at) AS b, count(DISTINCT user_id)::int AS n
      FROM (${writesSince(SPINE_START)}) w
      GROUP BY 1
    )
    SELECT spine.bucket_start,
           coalesce(active.n, 0) AS active,
           coalesce(captures.n, 0) AS captures,
           coalesce(notes.n, 0) AS notes,
           coalesce(chats.n, 0) AS chats,
           coalesce(imps.n, 0) AS imports
    FROM spine
    LEFT JOIN active ON active.b = spine.bucket_start
    LEFT JOIN captures ON captures.b = spine.bucket_start
    LEFT JOIN notes ON notes.b = spine.bucket_start
    LEFT JOIN chats ON chats.b = spine.bucket_start
    LEFT JOIN imps ON imps.b = spine.bucket_start
    ORDER BY spine.bucket_start
  `);
  return rowsOf<{
    bucket_start: string;
    active: number;
    captures: number;
    notes: number;
    chats: number;
    imports: number;
  }>(result).map((r) => ({
    bucketStart: toDate(r.bucket_start),
    active: num(r.active),
    captures: num(r.captures),
    notes: num(r.notes),
    chats: num(r.chats),
    imports: num(r.imports),
  }));
}

/**
 * Where each week's signups are in the workflow now: the furthest stage every account has
 * reached, as mutually exclusive counts so a week's bar stacks to its signups.
 *
 *   Signed up        nothing past account creation
 *   Onboarded        finished the tour or wizard, or imported (mirrors `needsOnboarding`)
 *   Has contacts     at least one contact — typed or imported
 *   Logged activity  a saved capture, a hand-logged note or a chat message: the loop the
 *                    product exists for, done at least once
 *   Came back        wrote anything seven or more days after signing up
 *
 * "Now", not "at the time": a week from March shows where March's signups stand today. So
 * the newest week always looks least advanced — its accounts cannot have "come back" yet.
 */
export async function workflowStagesTrend(
  grain: Grain = "week",
  buckets = 12
): Promise<WorkflowStagePoint[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    WITH spine AS (${series(grain, buckets)}),
    per_user AS (
      SELECT date_trunc(${grain}, s.created_at) AS b,
             CASE
               WHEN EXISTS (
                 SELECT 1 FROM (${writesSince(sql`s.created_at + interval '7 days'`)}) w
                 WHERE w.user_id = s.user_id
               ) THEN 5
               WHEN EXISTS (SELECT 1 FROM capture_jobs j WHERE j.user_id = s.user_id AND j.status = 'saved')
                 OR EXISTS (SELECT 1 FROM interactions x WHERE x.user_id = s.user_id
                              AND x.note_batch_id IS NULL AND x.external_id IS NULL)
                 OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.user_id = s.user_id AND m.role = 'user')
                 THEN 4
               WHEN EXISTS (SELECT 1 FROM contacts c WHERE c.user_id = s.user_id) THEN 3
               WHEN s.onboarding_completed_at IS NOT NULL
                 OR EXISTS (SELECT 1 FROM imports i WHERE i.user_id = s.user_id) THEN 2
               ELSE 1
             END AS stage
      FROM user_settings s
      WHERE s.created_at >= ${SPINE_START}
    )
    SELECT spine.bucket_start,
           count(p.b) FILTER (WHERE p.stage = 1)::int AS signed_up,
           count(p.b) FILTER (WHERE p.stage = 2)::int AS onboarded,
           count(p.b) FILTER (WHERE p.stage = 3)::int AS has_contacts,
           count(p.b) FILTER (WHERE p.stage = 4)::int AS logged,
           count(p.b) FILTER (WHERE p.stage = 5)::int AS came_back
    FROM spine
    LEFT JOIN per_user p ON p.b = spine.bucket_start
    GROUP BY spine.bucket_start
    ORDER BY spine.bucket_start
  `);
  return rowsOf<Record<string, string | number>>(result).map((r) => ({
    bucketStart: toDate(r.bucket_start as string),
    signedUp: num(r.signed_up),
    onboarded: num(r.onboarded),
    hasContacts: num(r.has_contacts),
    loggedActivity: num(r.logged),
    cameBack: num(r.came_back),
  }));
}

/**
 * Who keeps using Orbit week after week, not just who showed up once.
 *
 * For each week: accounts that wrote something that week, accounts that wrote in at least
 * three of the four weeks ending with it, and accounts that wrote in all four. The last two
 * are nested inside the first only loosely — someone active in weeks 1–3 but quiet this
 * week still counts as consistent, which is the point: one quiet week is not churn.
 */
export async function consistentUsersTrend(buckets = 12): Promise<ConsistencyPoint[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    WITH spine AS (${series("week", buckets)}),
    wk AS (
      SELECT DISTINCT user_id, date_trunc('week', created_at) AS week
      FROM (${writesSince(sql`${SPINE_START} - interval '21 days'`)}) w
    )
    SELECT spine.bucket_start,
           count(u.user_id) FILTER (WHERE u.this_week)::int AS active,
           count(u.user_id) FILTER (WHERE u.weeks >= 3)::int AS three_of_four,
           count(u.user_id) FILTER (WHERE u.weeks = 4)::int AS all_four
    FROM spine
    LEFT JOIN LATERAL (
      SELECT wk.user_id,
             count(*) AS weeks,
             bool_or(wk.week = spine.bucket_start) AS this_week
      FROM wk
      WHERE wk.week BETWEEN spine.bucket_start - interval '3 weeks' AND spine.bucket_start
      GROUP BY wk.user_id
    ) u ON true
    GROUP BY spine.bucket_start
    ORDER BY spine.bucket_start
  `);
  return rowsOf<Record<string, string | number>>(result).map((r) => ({
    bucketStart: toDate(r.bucket_start as string),
    active: num(r.active),
    threeOfFour: num(r.three_of_four),
    allFour: num(r.all_four),
  }));
}

/**
 * AI calls and their estimated cost per week, cost split by who pays for it.
 *
 * `key_owner = 'orbit'` is Orbit's managed keys — real spend. `'user'` is a BYOK key: the
 * account pays its provider, so it is shown for scale but is not Orbit's cost. The figure
 * is `estimated_cost_micros`, priced at call time from the model's list price; calls on a
 * model with no known price record NULL and are counted separately rather than as free.
 * Clamped to the `usage_events` retention window, like `aiVolumeTrend`.
 */
export async function aiWeeklyUsage(buckets = 12): Promise<AiWeekPoint[]> {
  const bounded = Math.min(buckets, Math.max(Math.floor(USAGE_EVENT_RETENTION_DAYS / 7), 1));
  const db = await getDb();
  const result = await db.execute(sql`
    WITH spine AS (${series("week", bounded)}),
    u AS (
      SELECT date_trunc('week', created_at) AS b, success, key_owner, estimated_cost_micros
      FROM usage_events
      WHERE created_at >= ${SPINE_START}
    )
    SELECT spine.bucket_start,
           count(u.b)::int AS calls,
           count(u.b) FILTER (WHERE u.success = 0)::int AS failures,
           coalesce(sum(u.estimated_cost_micros) FILTER (WHERE u.key_owner = 'orbit'), 0)::bigint AS orbit_micros,
           coalesce(sum(u.estimated_cost_micros) FILTER (WHERE u.key_owner <> 'orbit'), 0)::bigint AS user_micros,
           count(u.b) FILTER (WHERE u.estimated_cost_micros IS NULL)::int AS unpriced
    FROM spine
    LEFT JOIN u ON u.b = spine.bucket_start
    GROUP BY spine.bucket_start
    ORDER BY spine.bucket_start
  `);
  return rowsOf<Record<string, string | number>>(result).map((r) => ({
    bucketStart: toDate(r.bucket_start as string),
    calls: num(r.calls),
    failures: num(r.failures),
    orbitMicros: num(r.orbit_micros),
    userMicros: num(r.user_micros),
    unpriced: num(r.unpriced),
  }));
}

/** The most-used AI operations over a window, with their estimated cost. */
export async function aiOperationCosts(days = 84): Promise<AiOperationCostRow[]> {
  const span = sql.raw(`interval '${Math.max(1, Math.min(days, USAGE_EVENT_RETENTION_DAYS))} days'`);
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT operation,
           count(*)::int AS calls,
           count(DISTINCT user_id)::int AS users,
           count(*) FILTER (WHERE success = 0)::int AS failures,
           coalesce(sum(estimated_cost_micros), 0)::bigint AS micros,
           coalesce(sum(estimated_cost_micros) FILTER (WHERE key_owner = 'orbit'), 0)::bigint AS orbit_micros
    FROM usage_events
    WHERE created_at >= now() - ${span}
    GROUP BY operation
    ORDER BY calls DESC, operation
  `);
  return rowsOf<Record<string, string | number>>(result).map((r) => ({
    operation: String(r.operation),
    calls: num(r.calls),
    users: num(r.users),
    failures: num(r.failures),
    micros: num(r.micros),
    orbitMicros: num(r.orbit_micros),
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
 * How many accounts have ever touched each released feature, most-used first.
 *
 * The question this answers is which parts of Orbit are load-bearing and which are
 * decoration — the one cross-account total that does change a decision, unlike "contacts
 * across all accounts".
 *
 * Calendar is the one feature with two paths in: a pasted ICS feed
 * (`calendar_subscriptions`) or a connected account's calendars (`calendar_sources`,
 * Google, Microsoft or iCloud). An account counts once whichever it used.
 */
export async function featureAdoption(): Promise<FeatureAdoptionRow[]> {
  const db = await getDb();
  // Table names come from the constant list above, never from input, so sql.raw is safe.
  const columns = FEATURES.map(
    (f) => `(SELECT count(DISTINCT user_id) FROM ${f.table}) AS "${f.key}"`
  ).join(",\n      ");
  const result = await db.execute(sql`
    SELECT
      ${sql.raw(columns)},
      (SELECT count(*) FROM (
        SELECT user_id FROM calendar_subscriptions
        UNION
        SELECT user_id FROM calendar_sources
      ) AS c) AS "calendar"
  `);
  const row = rowsOf<Record<string, string | number>>(result)[0] ?? {};
  const rows: FeatureAdoptionRow[] = [
    ...FEATURES.map((f) => ({ key: f.key, label: f.label, count: num(row[f.key]) })),
    { key: "calendar", label: "Calendar", count: num(row.calendar) },
  ];
  return rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
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
