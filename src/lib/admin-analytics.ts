import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { series, type Grain } from "@/lib/admin-trends";
import { num, toDate } from "@/lib/admin-metrics";

/**
 * Read side of the traffic pipeline, for `/admin/analytics`. Writes live in
 * `src/lib/page-views.ts`.
 *
 * TWO RULES, both of which the numbers depend on and neither of which SQL enforces.
 *
 * BOTS ARE ALWAYS EXCLUDED. Every query here filters `is_bot = false`. `PV` below is the
 * only place that predicate is written, so a new aggregate cannot forget it.
 *
 * "UNIQUE VISITORS" IS VISITOR-DAYS. The visitor hash is salted per UTC day, so the same
 * person on three days is three hashes and `count(distinct visitor_hash)` over a range
 * counts visits-by-day, not people. That is the price of setting no cookie. It is stated
 * in the type below and printed on screen; do not quietly relabel it "people" anywhere.
 */

/** The one place the bot predicate is written. */
const PV = sql`page_views pv WHERE pv.is_bot = false`;

/** Ranges the page offers. A closed set — never interpolated from a query string. */
export type Range = "7d" | "30d" | "90d";

export const RANGES: readonly Range[] = ["7d", "30d", "90d"] as const;

export function rangeDays(range: Range): number {
  return range === "7d" ? 7 : range === "30d" ? 30 : 90;
}

/** The grain a range is charted at: daily up to a month, weekly beyond it. */
export function rangeGrain(range: Range): Grain {
  return range === "90d" ? "week" : "day";
}

export function rangeBuckets(range: Range): number {
  return range === "90d" ? 13 : rangeDays(range);
}

function since(range: Range, now: Date): string {
  return new Date(now.getTime() - rangeDays(range) * 86_400_000).toISOString();
}

export type TrafficTotals = {
  views: number;
  /** Distinct (visitor, day) pairs. NOT a headcount — see this module's note. */
  visitorDays: number;
  /**
   * Mean visitor-days per day, the closest honest answer to "how many people". NOT
   * rounded here — over a 90-day range a real trickle of visitors rounds to zero, and a
   * tile reading "~0/day" next to a non-zero total looks like a bug. The page formats it.
   */
  avgDailyVisitors: number;
  sessions: number;
  /** Median seconds from a session's first pageview to its last. Null with no sessions. */
  medianSessionSeconds: number | null;
  /** Sessions with exactly one pageview. */
  bouncedSessions: number;
  signedInViews: number;
  /** Rows excluded as automated, so a crawler wave is visible rather than merely absent. */
  botViews: number;
};

/**
 * The headline tiles.
 *
 * Session duration is measured FIRST PAGEVIEW TO LAST, plus the final view's recorded
 * dwell when the exit beacon landed. A one-page session with no dwell is therefore zero,
 * not unknown — which is why the bounce count sits beside it rather than being folded in.
 * The median, not the mean: one person who left a tab open over a weekend would otherwise
 * set the average for the week.
 */
export async function trafficTotals(
  range: Range = "30d",
  now: Date = new Date()
): Promise<TrafficTotals> {
  const db = await getDb();
  const from = since(range, now);
  const result = await db.execute(sql`
    WITH v AS (
      SELECT pv.visitor_hash, pv.session_id, pv.user_id, pv.created_at, pv.dwell_ms
      FROM ${PV} AND pv.created_at >= ${from}
    ),
    sessions AS (
      SELECT session_id,
             count(*)::int AS views,
             -- First pageview to last, plus however long the visitor stayed on that last
             -- page when the exit beacon landed. The ordered array_agg picks the newest
             -- row's dwell without a correlated subquery per session.
             EXTRACT(EPOCH FROM (max(created_at) - min(created_at)))
               + COALESCE((array_agg(dwell_ms ORDER BY created_at DESC))[1], 0) / 1000.0
               AS seconds
      FROM v
      GROUP BY session_id
    ),
    bots AS (
      SELECT count(*)::int AS n FROM page_views
      WHERE is_bot = true AND created_at >= ${from}
    )
    SELECT
      (SELECT count(*)::int FROM v) AS views,
      (SELECT count(DISTINCT (visitor_hash, date_trunc('day', created_at)))::int FROM v) AS visitor_days,
      (SELECT count(*)::int FROM sessions) AS sessions,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) FROM sessions) AS median_seconds,
      (SELECT count(*)::int FROM sessions WHERE views = 1) AS bounced,
      (SELECT count(*)::int FROM v WHERE user_id IS NOT NULL) AS signed_in,
      (SELECT n FROM bots) AS bot_views
  `);
  const row = rowsOf<{
    views: number;
    visitor_days: number;
    sessions: number;
    median_seconds: string | number | null;
    bounced: number;
    signed_in: number;
    bot_views: number;
  }>(result)[0];

  const visitorDays = num(row?.visitor_days);
  const days = rangeDays(range);
  return {
    views: num(row?.views),
    visitorDays,
    avgDailyVisitors: days > 0 ? visitorDays / days : 0,
    sessions: num(row?.sessions),
    medianSessionSeconds:
      row?.median_seconds == null ? null : Math.round(num(row.median_seconds)),
    bouncedSessions: num(row?.bounced),
    signedInViews: num(row?.signed_in),
    botViews: num(row?.bot_views),
  };
}

export type TrafficPoint = {
  bucketStart: Date;
  views: number;
  visitorDays: number;
};

/**
 * Views and visitor-days per bucket, gap-filled by the shared `series()` spine.
 *
 * No `now` parameter, unlike its neighbours. `series()` anchors its spine on SQL `now()`,
 * so one passed in here would be accepted, ignored, and silently return today's buckets
 * for a caller that asked for last month's — worse than not offering it.
 */
export async function trafficTrend(
  grain: Grain = "day",
  buckets = 30
): Promise<TrafficPoint[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    WITH spine AS (${series(grain, buckets)})
    SELECT spine.bucket_start,
           count(pv.id)::int AS views,
           count(DISTINCT pv.visitor_hash)::int AS visitors
    FROM spine
    LEFT JOIN page_views pv
      ON pv.is_bot = false
     AND date_trunc(${grain}, pv.created_at) = spine.bucket_start
    GROUP BY spine.bucket_start
    ORDER BY spine.bucket_start
  `);
  return rowsOf<{ bucket_start: string; views: number; visitors: number }>(result).map(
    (r) => ({
      bucketStart: toDate(r.bucket_start) ?? new Date(0),
      views: num(r.views),
      visitorDays: num(r.visitors),
    })
  );
}

export type RouteRow = {
  route: string;
  views: number;
  visitorDays: number;
  /** Median seconds on the page, from the exit beacon. Null when none ever landed. */
  medianDwellSeconds: number | null;
};

export async function topRoutes(
  range: Range = "30d",
  limit = 20,
  now: Date = new Date()
): Promise<RouteRow[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT pv.route,
           count(*)::int AS views,
           count(DISTINCT (pv.visitor_hash, date_trunc('day', pv.created_at)))::int AS visitor_days,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY pv.dwell_ms) AS median_dwell
    FROM ${PV} AND pv.created_at >= ${since(range, now)}
    GROUP BY pv.route
    ORDER BY views DESC
    LIMIT ${limit}
  `);
  return rowsOf<{
    route: string;
    views: number;
    visitor_days: number;
    median_dwell: string | number | null;
  }>(result).map((r) => ({
    route: r.route,
    views: num(r.views),
    visitorDays: num(r.visitor_days),
    medianDwellSeconds:
      r.median_dwell == null ? null : Math.round(num(r.median_dwell) / 1000),
  }));
}

export type GeoRow = {
  country: string | null;
  region: string | null;
  city: string | null;
  views: number;
  visitorDays: number;
};

/**
 * Geography, at three levels from one query.
 *
 * `GROUPING SETS` rather than three round trips — the page shows country totals with
 * region and city underneath, and running that as separate queries would put three
 * statements on the budget to answer one question.
 *
 * Rows are never joined to `user_id` anywhere in the UI. At Orbit's traffic a city and a
 * timestamp together are close enough to an identifier that pairing them with an account
 * would turn an aggregate report into a location history.
 */
export async function geoBreakdown(
  range: Range = "30d",
  now: Date = new Date()
): Promise<{ countries: GeoRow[]; regions: GeoRow[]; cities: GeoRow[] }> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT pv.country,
           pv.region,
           pv.city,
           GROUPING(pv.region) AS g_region,
           GROUPING(pv.city) AS g_city,
           count(*)::int AS views,
           count(DISTINCT (pv.visitor_hash, date_trunc('day', pv.created_at)))::int AS visitor_days
    FROM ${PV} AND pv.created_at >= ${since(range, now)} AND pv.country IS NOT NULL
    GROUP BY GROUPING SETS ((pv.country), (pv.country, pv.region), (pv.country, pv.region, pv.city))
    ORDER BY views DESC
  `);
  const rows = rowsOf<{
    country: string | null;
    region: string | null;
    city: string | null;
    g_region: number;
    g_city: number;
    views: number;
    visitor_days: number;
  }>(result);

  const shape = (r: (typeof rows)[number]): GeoRow => ({
    country: r.country,
    region: r.region,
    city: r.city,
    views: num(r.views),
    visitorDays: num(r.visitor_days),
  });

  return {
    countries: rows.filter((r) => num(r.g_region) === 1).map(shape).slice(0, 25),
    regions: rows
      .filter((r) => num(r.g_region) === 0 && num(r.g_city) === 1)
      .map(shape)
      .slice(0, 25),
    cities: rows.filter((r) => num(r.g_city) === 0).map(shape).slice(0, 25),
  };
}

export type SourceRow = { label: string; views: number; visitorDays: number };

/**
 * Where traffic came from: external referrer hosts and named UTM campaigns.
 *
 * Both halves in one statement, tagged by `kind`. "Direct" is left implicit — a row for it
 * would swamp the chart and say only "most people typed the URL", which the totals
 * already imply.
 */
export async function sourceBreakdown(
  range: Range = "30d",
  now: Date = new Date()
): Promise<{ referrers: SourceRow[]; campaigns: SourceRow[] }> {
  const db = await getDb();
  const from = since(range, now);
  const result = await db.execute(sql`
    SELECT 'referrer' AS kind,
           pv.referrer_host AS label,
           count(*)::int AS views,
           count(DISTINCT (pv.visitor_hash, date_trunc('day', pv.created_at)))::int AS visitor_days
    FROM ${PV} AND pv.created_at >= ${from} AND pv.referrer_host IS NOT NULL
    GROUP BY pv.referrer_host
    UNION ALL
    SELECT 'campaign' AS kind,
           COALESCE(pv.utm_campaign, pv.utm_source) AS label,
           count(*)::int AS views,
           count(DISTINCT (pv.visitor_hash, date_trunc('day', pv.created_at)))::int AS visitor_days
    FROM ${PV} AND pv.created_at >= ${from}
      AND (pv.utm_campaign IS NOT NULL OR pv.utm_source IS NOT NULL)
    GROUP BY COALESCE(pv.utm_campaign, pv.utm_source)
    ORDER BY views DESC
  `);
  const rows = rowsOf<{
    kind: string;
    label: string;
    views: number;
    visitor_days: number;
  }>(result);
  const shape = (r: (typeof rows)[number]): SourceRow => ({
    label: r.label,
    views: num(r.views),
    visitorDays: num(r.visitor_days),
  });
  return {
    referrers: rows.filter((r) => r.kind === "referrer").map(shape).slice(0, 15),
    campaigns: rows.filter((r) => r.kind === "campaign").map(shape).slice(0, 15),
  };
}

export type DeviceRow = { device: string; views: number; visitorDays: number };

export async function deviceBreakdown(
  range: Range = "30d",
  now: Date = new Date()
): Promise<DeviceRow[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT pv.device,
           count(*)::int AS views,
           count(DISTINCT (pv.visitor_hash, date_trunc('day', pv.created_at)))::int AS visitor_days
    FROM ${PV} AND pv.created_at >= ${since(range, now)}
    GROUP BY pv.device
    ORDER BY views DESC
  `);
  return rowsOf<{ device: string; views: number; visitor_days: number }>(result).map(
    (r) => ({
      device: r.device,
      views: num(r.views),
      visitorDays: num(r.visitor_days),
    })
  );
}

/* ------------------------------------------------------------------------------------
 * The acquisition funnel
 * --------------------------------------------------------------------------------- */

export type FunnelStage = {
  label: string;
  count: number;
  /** What this stage is a fraction OF, for the "9 of 14" rendering. Null on the first. */
  of: number | null;
  note?: string;
};

/**
 * Visitor through to paid, as DAILY COHORTS rather than per-person attribution.
 *
 * This is the honest shape, and the constraint that forces it is the same one that keeps
 * the pipeline cookieless: a visitor hash is salted per day, so there is no key that
 * connects the person who read `/pricing` on Tuesday to the account that signed up on
 * Thursday. Stages 1-2 count traffic in the window and stages 3-6 count accounts created
 * in the same window. Those are different populations measured over the same days — which
 * is what a funnel at this scale can support, and nothing here should be read as "this
 * visitor became that customer".
 *
 * `buildFunnel` in `admin-metrics.ts` covers signup onward and stops before money. This
 * one deliberately spans the whole thing, because the question it exists to answer —
 * conversion rate — needs both ends.
 */
export async function acquisitionFunnel(
  range: Range = "30d",
  now: Date = new Date()
): Promise<FunnelStage[]> {
  const db = await getDb();
  const from = since(range, now);

  const traffic = await db.execute(sql`
    SELECT
      count(DISTINCT (pv.visitor_hash, date_trunc('day', pv.created_at)))::int AS visitors,
      count(DISTINCT (pv.visitor_hash, date_trunc('day', pv.created_at)))
        FILTER (WHERE pv.route IN ('/pricing', '/interest', '/upgrade'))::int AS intent
    FROM ${PV} AND pv.created_at >= ${from}
  `);
  const t = rowsOf<{ visitors: number; intent: number }>(traffic)[0];

  // `isOnboarded` in admin-metrics.ts is the JS form of the same predicate: the column
  // alone undercounts, because `needsOnboarding` treats any contact or import as onboarded
  // and backfills the timestamp later. The two must not drift.
  //
  // The paid test is `mrr_delta_cents > 0` OR a lifetime purchase. The MRR test alone —
  // which is what `paidSignupsByChannel` uses, correctly, for a per-month figure — scores
  // zero for every Lifetime customer, because a one-off payment moves no recurring revenue.
  const accounts = await db.execute(sql`
    SELECT
      count(*)::int AS signups,
      count(*) FILTER (
        WHERE s.onboarding_completed_at IS NOT NULL
           OR EXISTS (SELECT 1 FROM contacts c WHERE c.user_id = s.user_id)
           OR EXISTS (SELECT 1 FROM imports i WHERE i.user_id = s.user_id)
      )::int AS activated,
      count(*) FILTER (
        WHERE s.lifetime_purchased_at IS NOT NULL
           OR EXISTS (
             SELECT 1 FROM billing_events b
             WHERE b.user_id = s.user_id
               AND (b.mrr_delta_cents > 0 OR b.kind = 'lifetime')
           )
      )::int AS paid,
      (SELECT count(*)::int FROM interest_list_signups WHERE created_at >= ${from}) AS interest
    FROM user_settings s
    WHERE s.created_at >= ${from}
  `);
  const a = rowsOf<{
    signups: number;
    activated: number;
    paid: number;
    interest: number;
  }>(accounts)[0];

  const visitors = num(t?.visitors);
  const signups = num(a?.signups);

  return [
    { label: "Unique visitors", count: visitors, of: null, note: "visitor-days, not people" },
    { label: "Reached pricing or interest", count: num(t?.intent), of: visitors },
    {
      label: "Joined the interest list",
      count: num(a?.interest),
      of: visitors,
      note: "not linkable to an account except by email",
    },
    { label: "Created an account", count: signups, of: visitors },
    { label: "Activated", count: num(a?.activated), of: signups },
    { label: "Paid", count: num(a?.paid), of: signups },
  ];
}

/**
 * The minimum denominator a percentage is allowed to have.
 *
 * `/admin/growth` bans rates outright — "at this scale a percentage is two people wearing
 * a confidence interval". Conversion rate is the one question that cannot be answered
 * without one, so the compromise is this: every rate prints its own fraction beside it,
 * and below this many observations the percentage is withheld entirely rather than
 * dressing up a coin flip as a trend.
 */
export const MIN_RATE_DENOMINATOR = 30;

/**
 * Seconds as a short human duration. Shared by the traffic page and the per-account
 * section on the user inspector, so "4m 12s" means the same thing in both.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

/** "9 of 14" — with "(64%)" appended only once the denominator can support it. */
export function formatRate(count: number, of: number | null): string {
  if (of == null || of === 0) return count.toLocaleString();
  const fraction = `${count.toLocaleString()} of ${of.toLocaleString()}`;
  if (of < MIN_RATE_DENOMINATOR) return fraction;
  return `${fraction} (${Math.round((count / of) * 100)}%)`;
}

/* ------------------------------------------------------------------------------------
 * Per-account traffic
 * --------------------------------------------------------------------------------- */

export type AccountTraffic = {
  views: number;
  sessions: number;
  /** Distinct UTC days with at least one view — "how many days did they show up". */
  activeDays: number;
  medianSessionSeconds: number | null;
  /** Total measured time on page across the window. Best-effort; see `dwellCoverage`. */
  totalDwellSeconds: number;
  /** Share of views with a recorded dwell, so a thin sample is visible as one. */
  dwellCoverage: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
  routes: RouteRow[];
};

/**
 * One account's own traffic: what they opened, how often, and how long they stayed.
 *
 * THIS IS PER-PERSON BEHAVIOUR, not an aggregate, and it is the one place in this module
 * where that is true. It works because `page_views.user_id` is set on views from a
 * signed-in session — the anonymous half of the pipeline stays anonymous, but a logged-in
 * visit is attributable by definition, and pretending otherwise would be theatre. What
 * follows from that is a disclosure obligation, not a technical one: the privacy page says
 * plainly that signed-in page views are recorded against the account.
 *
 * `total_dwell` is a SUM of a best-effort measurement, so `dwellCoverage` rides along with
 * it. A total built from three of forty views is not wrong, but it is not the answer to
 * "how long have they spent in Orbit" either, and the UI says which it is.
 */
export async function accountTraffic(
  userId: string,
  range: Range = "30d",
  now: Date = new Date()
): Promise<AccountTraffic> {
  const db = await getDb();
  const from = since(range, now);

  const summary = await db.execute(sql`
    WITH v AS (
      SELECT pv.session_id, pv.created_at, pv.dwell_ms
      FROM ${PV} AND pv.user_id = ${userId} AND pv.created_at >= ${from}
    ),
    sessions AS (
      SELECT session_id,
             EXTRACT(EPOCH FROM (max(created_at) - min(created_at)))
               + COALESCE((array_agg(dwell_ms ORDER BY created_at DESC))[1], 0) / 1000.0
               AS seconds
      FROM v
      GROUP BY session_id
    )
    SELECT
      (SELECT count(*)::int FROM v) AS views,
      (SELECT count(*)::int FROM sessions) AS sessions,
      (SELECT count(DISTINCT date_trunc('day', created_at))::int FROM v) AS active_days,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) FROM sessions) AS median_seconds,
      (SELECT COALESCE(sum(dwell_ms), 0) FROM v) AS total_dwell_ms,
      (SELECT count(dwell_ms)::int FROM v) AS with_dwell,
      (SELECT min(created_at) FROM v) AS first_seen,
      (SELECT max(created_at) FROM v) AS last_seen
  `);
  const s = rowsOf<{
    views: number;
    sessions: number;
    active_days: number;
    median_seconds: string | number | null;
    total_dwell_ms: string | number | null;
    with_dwell: number;
    first_seen: string | null;
    last_seen: string | null;
  }>(summary)[0];

  const routeRows = await db.execute(sql`
    SELECT pv.route,
           count(*)::int AS views,
           count(DISTINCT date_trunc('day', pv.created_at))::int AS visitor_days,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY pv.dwell_ms) AS median_dwell
    FROM ${PV} AND pv.user_id = ${userId} AND pv.created_at >= ${from}
    GROUP BY pv.route
    ORDER BY views DESC
    LIMIT 15
  `);

  const views = num(s?.views);
  return {
    views,
    sessions: num(s?.sessions),
    activeDays: num(s?.active_days),
    medianSessionSeconds:
      s?.median_seconds == null ? null : Math.round(num(s.median_seconds)),
    totalDwellSeconds: Math.round(num(s?.total_dwell_ms) / 1000),
    dwellCoverage: views > 0 ? num(s?.with_dwell) / views : 0,
    firstSeen: toDate(s?.first_seen),
    lastSeen: toDate(s?.last_seen),
    routes: rowsOf<{
      route: string;
      views: number;
      visitor_days: number;
      median_dwell: string | number | null;
    }>(routeRows).map((r) => ({
      route: r.route,
      views: num(r.views),
      // For one account this is DAYS THEY OPENED IT, not distinct visitors — the field is
      // shared with the site-wide row type, and the per-account UI labels it accordingly.
      visitorDays: num(r.visitor_days),
      medianDwellSeconds:
        r.median_dwell == null ? null : Math.round(num(r.median_dwell) / 1000),
    })),
  };
}

export type AccountTrafficRow = {
  userId: string;
  email: string | null;
  views: number;
  sessions: number;
  activeDays: number;
  totalDwellSeconds: number;
  lastSeen: Date | null;
};

/**
 * Accounts ranked by how much they actually used the product in the window.
 *
 * Distinct from `activeTrend` in `admin-trends.ts`, which counts accounts that WROTE
 * something across five tables. This counts accounts that showed up and looked — the
 * people who open Orbit daily and read without editing are invisible to the write-based
 * measure and are exactly who this finds.
 */
export async function topAccountsByTraffic(
  range: Range = "30d",
  limit = 20,
  now: Date = new Date()
): Promise<AccountTrafficRow[]> {
  const db = await getDb();
  // A CTE rather than joining onto `PV` directly: that fragment carries its own WHERE, so
  // a LEFT JOIN written after it would land after the WHERE clause and not parse.
  const result = await db.execute(sql`
    WITH v AS (
      SELECT pv.user_id, pv.session_id, pv.created_at, pv.dwell_ms
      FROM ${PV} AND pv.user_id IS NOT NULL AND pv.created_at >= ${since(range, now)}
    )
    SELECT v.user_id,
           s.email,
           count(*)::int AS views,
           count(DISTINCT v.session_id)::int AS sessions,
           count(DISTINCT date_trunc('day', v.created_at))::int AS active_days,
           COALESCE(sum(v.dwell_ms), 0) AS total_dwell_ms,
           max(v.created_at) AS last_seen
    FROM v
    LEFT JOIN user_settings s ON s.user_id = v.user_id
    GROUP BY v.user_id, s.email
    ORDER BY views DESC
    LIMIT ${limit}
  `);
  return rowsOf<{
    user_id: string;
    email: string | null;
    views: number;
    sessions: number;
    active_days: number;
    total_dwell_ms: string | number | null;
    last_seen: string | null;
  }>(result).map((r) => ({
    userId: r.user_id,
    email: r.email,
    views: num(r.views),
    sessions: num(r.sessions),
    activeDays: num(r.active_days),
    totalDwellSeconds: Math.round(num(r.total_dwell_ms) / 1000),
    lastSeen: toDate(r.last_seen),
  }));
}
