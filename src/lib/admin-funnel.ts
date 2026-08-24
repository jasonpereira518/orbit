import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { num, toDate } from "@/lib/admin-metrics";
import { PRESENCE_WINDOW_MS } from "@/lib/presence-window";

/**
 * Where people come from, and whether they stay.
 *
 * Two things here are newly possible rather than newly displayed:
 *
 *   CHANNEL. Nothing captured acquisition until `signup_referrer` and the UTM columns
 *   shipped, so "where do users come from" was not a question the console answered badly —
 *   it was one it could not answer at all.
 *
 *   ENGAGEMENT DEPTH. The presence heartbeat writes `last_active_at` every 45 seconds from
 *   any visible tab. Before it, that column moved at most once per fifteen minutes and only
 *   on a server request, so somebody reading and scrolling registered as idle and DAU was
 *   unmeasurable for exactly the users who were reading rather than clicking.
 *
 * FRAMED AS DISCOVERY, NOT CAC. There is no ad spend to divide by, so any cost-per-
 * acquisition figure here would be a division by zero dressed up as a metric. What the
 * channel table is for is noticing that half the signups came from one thread — which is a
 * decision about where to spend the next hour, and survives a dozen accounts intact.
 */

export type Channel = {
  channel: string;
  accounts: number;
  activated: number;
  /** Null when the cohort is too small to express as a rate without misleading. */
  activationRate: number | null;
  firstAt: Date | null;
};

/**
 * Below this many accounts in a channel, no percentage is shown.
 *
 * With two accounts an activation rate can only be 0, 50 or 100 — a number that swings
 * fifty points on one person and reads as a finding. The counts are shown regardless;
 * only the ratio is withheld.
 */
export const CHANNEL_RATE_MINIMUM = 5;

export async function channelBreakdown(): Promise<Channel[]> {
  const db = await getDb();

  // The channel expression mirrors `channelOf` in `attribution.ts`. Kept in SQL so the
  // grouping happens in the database, and deliberately including the "unattributed"
  // bucket: hiding accounts that predate the mirror would make every rate look better
  // than it is by quietly shrinking the denominator.
  const result = await db.execute(sql`
    SELECT
      CASE
        WHEN signup_utm_source IS NOT NULL THEN signup_utm_source
        WHEN signup_referrer   IS NOT NULL THEN signup_referrer
        WHEN signup_attributed_at IS NOT NULL THEN 'direct'
        ELSE 'unattributed'
      END                                        AS channel,
      count(*)::int                              AS accounts,
      count(onboarding_completed_at)::int        AS activated,
      min(created_at)                            AS first_at
    FROM user_settings
    GROUP BY 1
    ORDER BY accounts DESC, channel ASC
  `);

  return rowsOf<{
    channel: string;
    accounts: number;
    activated: number;
    first_at: string | Date | null;
  }>(result).map((r) => {
    const accounts = num(r.accounts);
    const activated = num(r.activated);
    return {
      channel: r.channel,
      accounts,
      activated,
      activationRate:
        accounts >= CHANNEL_RATE_MINIMUM
          ? Math.round((activated / accounts) * 100)
          : null,
      firstAt: toDate(r.first_at),
    };
  });
}

export type EngagementDepth = {
  dau: number;
  wau: number;
  mau: number;
  /** DAU ÷ MAU as a percentage. Null when MAU is too small to divide meaningfully. */
  stickiness: number | null;
  /** Beating right now, within the presence window. */
  liveNow: number;
  minimumForStickiness: number;
};

/**
 * Below this MAU, the stickiness ratio is withheld.
 *
 * DAU÷MAU over eight accounts moves twelve points per person. The three counts are always
 * shown; it is the derived ratio that misleads.
 */
export const STICKINESS_MINIMUM_MAU = 20;

/**
 * Takes no `now`, unlike most helpers here: every window below is evaluated by the database
 * clock. Accepting one would imply the caller can shift the reference time when it cannot,
 * and the database clock is the better reference anyway — it is the same one that wrote
 * `last_active_at`, so the comparison cannot be skewed by a lagging app server.
 */
export async function engagementDepth(): Promise<EngagementDepth> {
  const db = await getDb();

  const result = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE last_active_at > now() - interval '1 day')::int   AS dau,
      count(*) FILTER (WHERE last_active_at > now() - interval '7 days')::int  AS wau,
      count(*) FILTER (WHERE last_active_at > now() - interval '30 days')::int AS mau,
      count(*) FILTER (
        WHERE last_active_at > now() - make_interval(secs => ${PRESENCE_WINDOW_MS / 1000})
      )::int AS live_now
    FROM user_settings
  `);

  const row = rowsOf<Record<string, number>>(result)[0] ?? {};
  const dau = num(row.dau);
  const mau = num(row.mau);

  return {
    dau,
    wau: num(row.wau),
    mau,
    stickiness:
      mau >= STICKINESS_MINIMUM_MAU ? Math.round((dau / mau) * 100) : null,
    liveNow: num(row.live_now),
    minimumForStickiness: STICKINESS_MINIMUM_MAU,
  };
}

export type TopOfFunnel = {
  /** Waitlist entries seen, from the webhook ledger. Null when it is not instrumented. */
  waitlistEntries: number | null;
  signups: number;
  activated: number;
  /** Accounts that have created at least one contact. The first real use of the product. */
  everWrote: number;
};

/**
 * Landing to first contact, as counts.
 *
 * The stages are not a strict funnel and are not drawn as one: a visitor can sign up
 * without ever joining the waitlist, so waitlist entries are not a superset of signups and
 * subtracting them would produce a negative "drop-off". Shown as four independent counts
 * rather than as percentages between them, which is the honest shape for what is actually
 * measured.
 */
export async function topOfFunnel(): Promise<TopOfFunnel> {
  const db = await getDb();

  const waitlist = await db
    .execute(
      sql`SELECT count(DISTINCT resource_id)::int AS n
          FROM webhook_deliveries
          WHERE event_type LIKE 'waitlistEntry.%'`
    )
    .then((r) => num(rowsOf<{ n: number }>(r)[0]?.n))
    .catch(() => null);

  const counts = await db.execute(sql`
    SELECT
      count(*)::int                        AS signups,
      count(onboarding_completed_at)::int  AS activated,
      (SELECT count(DISTINCT user_id)::int FROM contacts) AS ever_wrote
    FROM user_settings
  `);

  const row = rowsOf<Record<string, number>>(counts)[0] ?? {};

  return {
    waitlistEntries: waitlist,
    signups: num(row.signups),
    activated: num(row.activated),
    everWrote: num(row.ever_wrote),
  };
}
