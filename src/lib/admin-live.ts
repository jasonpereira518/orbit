import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { num } from "@/lib/admin-metrics";
import { PRESENCE_WINDOW_MS } from "@/lib/presence-window";
import { FREE_CONTACT_LIMIT } from "@/lib/plan-limits";
import type { LiveScreen, LiveValues } from "@/lib/admin-live-tiers";

/**
 * The numbers each console screen keeps fresh without a reload.
 *
 * DEDICATED QUERIES, NOT THE PAGE LOADERS. It would be less code to poll
 * `getAdminOverview()` — and it would also re-run six aggregate scans every thirty
 * seconds, forever, on a console someone leaves open all day. Everything here is one
 * cheap statement per screen, deliberately narrower than what the screen renders.
 *
 * WHAT IS DELIBERATELY NOT LIVE. Anything whose shape can change — a list gaining a row,
 * a table reordering — is excluded, because a live update must never move something the
 * operator is already reading. `LiveValue` replaces text inside a node that already
 * exists; it cannot add one. So the alert list, the decisions list and every table stay
 * exactly as the server rendered them.
 *
 * The Overview's "needs attention" count is a specific casualty of that rule and worth
 * naming: computing it means loading the whole roster, so making it live would cost six
 * scans a tick to keep one integer honest. It stays static rather than becoming either
 * expensive or approximate.
 */

/** One statement: every headline integer the Overview shows, off a single scan. */
async function overviewValues(): Promise<LiveValues> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT
      count(*)::int AS total_users,
      count(*) FILTER (
        WHERE comped_plan IS NOT NULL
           OR lifetime_purchased_at IS NOT NULL
           OR subscription_plan = 'orbit'
      )::int AS paid,
      count(*) FILTER (WHERE subscription_plan = 'orbit' AND comped_plan IS NULL)::int
        AS subscribed,
      count(*) FILTER (WHERE comped_plan IS NOT NULL)::int AS comped,
      count(lifetime_purchased_at)::int AS lifetime_sold,
      count(*) FILTER (
        WHERE last_active_at > now() - make_interval(secs => ${PRESENCE_WINDOW_MS / 1000})
      )::int AS live_now,
      count(*) FILTER (WHERE last_active_at > now() - interval '7 days')::int AS active_7d
    FROM user_settings
  `);
  const row = rowsOf<Record<string, number>>(result)[0] ?? {};
  // One more round trip, and a cheap one — `getSystemIssueCount` is several scalar
  // subqueries in a single statement.
  const { getSystemIssueCount } = await import("@/lib/admin-system");
  const systemIssues = await getSystemIssueCount().catch(() => null);
  return {
    systemIssues,
    totalUsers: num(row.total_users),
    paid: num(row.paid),
    subscribed: num(row.subscribed),
    comped: num(row.comped),
    lifetimeSold: num(row.lifetime_sold),
    liveNow: num(row.live_now),
    activeLast7d: num(row.active_7d),
  };
}

async function healthValues(): Promise<LiveValues> {
  const { getSystemIssueCount } = await import("@/lib/admin-system");
  const issues = await getSystemIssueCount().catch(() => null);
  return { systemIssues: issues };
}

async function funnelValues(): Promise<LiveValues> {
  const { engagementDepth } = await import("@/lib/admin-funnel");
  const depth = await engagementDepth();
  return {
    dau: depth.dau,
    wau: depth.wau,
    mau: depth.mau,
    liveNow: depth.liveNow,
    // Null when the cohort is too small to divide honestly — the panel says why, and a
    // live update must not quietly turn a withheld ratio into a number.
    stickiness: depth.stickiness,
  };
}

/**
 * Formatted, not raw cents. Nothing on the client does arithmetic on these — they are
 * pushed straight into a node — and shipping `4500` where the screen reads `$45.00` is a
 * bug waiting for the first poll to land.
 */
async function billingValues(): Promise<LiveValues> {
  const { mrrReconciliation, formatCents } = await import("@/lib/admin-economics");
  const drift = await mrrReconciliation().catch(() => null);
  if (!drift) return { mrr: null, ledger: null, drift: null };
  return {
    mrr: formatCents(drift.liveCents),
    ledger: formatCents(drift.ledgerCents),
    drift: formatCents(drift.driftCents),
  };
}

/** One statement rather than the roster: how many free accounts are sitting at the cap. */
async function productValues(): Promise<LiveValues> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE c.n >= ${FREE_CONTACT_LIMIT})::int AS at_cap,
      count(*) FILTER (
        WHERE c.n >= ${Math.floor(FREE_CONTACT_LIMIT * 0.9)} AND c.n < ${FREE_CONTACT_LIMIT}
      )::int AS near_cap
    FROM user_settings u
    LEFT JOIN (
      SELECT user_id, count(*)::int AS n FROM contacts GROUP BY user_id
    ) c ON c.user_id = u.user_id
    WHERE u.comped_plan IS NULL
      AND u.lifetime_purchased_at IS NULL
      AND (u.subscription_plan IS NULL OR u.subscription_plan <> 'orbit')
  `);
  const row = rowsOf<Record<string, number>>(result)[0] ?? {};
  return { atCap: num(row.at_cap), nearCap: num(row.near_cap) };
}

const LOADERS: Record<LiveScreen, () => Promise<LiveValues>> = {
  overview: overviewValues,
  health: healthValues,
  funnel: funnelValues,
  billing: billingValues,
  product: productValues,
};

export async function liveValues(screen: LiveScreen): Promise<LiveValues> {
  return LOADERS[screen]();
}
