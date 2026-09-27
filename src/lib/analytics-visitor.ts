import { createHash } from "node:crypto";

/**
 * Cookieless visitor identity for traffic analytics.
 *
 * A visitor is `sha256(dailySalt + ip + userAgent)`, where `dailySalt` is itself
 * `sha256(ANALYTICS_SALT + "YYYY-MM-DD")`. Three properties follow, and all three are the
 * point:
 *
 *  - NO COOKIE IS SET, so there is nothing to ask consent for and nothing for a visitor to
 *    clear. This is the Plausible/Fathom construction.
 *  - THE IP IS NEVER STORED. It is an input to the hash inside the route handler and is
 *    discarded with the request. No column anywhere in the schema holds one.
 *  - THE HASH DOES NOT SURVIVE MIDNIGHT UTC. Re-deriving yesterday's identity needs the
 *    secret AND a candidate IP AND a candidate user agent, so a leaked copy of
 *    `page_views` reverses to nothing on its own.
 *
 * THE COST, which every number built on this has to be labelled for: distinct hashes over
 * a multi-day range are VISITOR-DAYS, not people. One person visiting on three days is
 * three hashes, and no amount of SQL can put them back together. `admin-analytics.ts`
 * says so on screen rather than passing the sum off as a headcount.
 *
 * FAIL-CLOSED. With no `ANALYTICS_SALT` there is no tracking at all — `hashVisitor` throws
 * rather than falling back to an unsalted digest, which would be a plain hash of an IP and
 * therefore reversible by anyone with a list of IPs to try.
 */

/** Whether traffic collection is configured. Optional by design: see `analyticsDisabledReason`. */
export function analyticsEnabled(): boolean {
  return Boolean(process.env.ANALYTICS_SALT);
}

/**
 * Why the console has no data, phrased for an operator.
 *
 * `ANALYTICS_SALT` is deliberately NOT required by `check:env`: that gate blocks every
 * production deploy at once, and a missing analytics secret should never be able to take
 * the product down. The cost of that choice is that "no rows" is ambiguous — so the admin
 * page asks this and says which of the two it is looking at.
 */
export function analyticsDisabledReason(): string | null {
  return analyticsEnabled()
    ? null
    : "ANALYTICS_SALT is not set, so no traffic is being recorded.";
}

/** UTC day key. UTC rather than local time so the rotation does not move with the season. */
function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function dailySalt(now: Date): string {
  const secret = process.env.ANALYTICS_SALT;
  if (!secret) {
    throw new Error("ANALYTICS_SALT is not set — refusing to hash without a salt.");
  }
  return createHash("sha256").update(`${secret}:${dayKey(now)}`).digest("hex");
}

/**
 * The visitor identifier written to `page_views.visitor_hash`.
 *
 * Throws when unsalted — callers check `analyticsEnabled()` first and drop the request.
 */
export function hashVisitor(
  ip: string,
  userAgent: string,
  now: Date = new Date()
): string {
  return createHash("sha256")
    .update(`${dailySalt(now)}:${ip}:${userAgent}`)
    .digest("hex");
}

export type DeviceKind = "desktop" | "mobile" | "tablet";

/**
 * Coarse device class. Three buckets, because that is the granularity anyone acts on —
 * a full UA parse would add a dependency and a high-cardinality column to answer a
 * question nobody is asking.
 */
export function deviceFromUserAgent(userAgent: string): DeviceKind {
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/.test(ua)) return "mobile";
  return "desktop";
}
