/**
 * The browser half of traffic analytics: which paths count, and what Vercel's scripts may
 * see. Pure and dependency-free, because it runs in every page's bundle.
 *
 * WHY IT KNOWS NO ROUTES. This module ships to every page — the waitlist's own domain
 * included (see `lib/waitlist-host.ts`), which must not carry a list of the app's pages in
 * its JavaScript. So the route vocabulary (`ROUTE_PATTERNS`, `normalizeRoute`) lives in
 * `analytics-routes.ts`, which only the server imports, and the vendor redaction below
 * works from the SHAPE of a segment instead: anything that looks like an id or a token is
 * replaced, whatever route it sits in.
 */

/**
 * Whether a path should be recorded at all.
 *
 * `/admin` is excluded because the operator reading these numbers is the person generating
 * them — counting his own console visits would make the traffic graph a picture of how
 * often he checked the traffic graph. API routes and Next's internals are not pages.
 */
export function isTrackedPath(pathname: string): boolean {
  const clean = (pathname.split("?")[0] ?? "").split("#")[0] ?? "";
  if (!clean.startsWith("/")) return false;
  if (clean === "/admin" || clean.startsWith("/admin/")) return false;
  if (clean.startsWith("/api/")) return false;
  if (clean.startsWith("/_next/") || clean.startsWith("/__clerk/")) return false;
  return true;
}

/**
 * The `localStorage` flag behind "don't count this browser" on `/admin/analytics`. The
 * beacon sends `internal: true` while it is set, which is the only way the operator's
 * SIGNED-OUT visits to the landing page can be told apart from a prospect's. Neutral on
 * purpose, like the session key: storage keys are visible in devtools on the waitlist too.
 */
export const INTERNAL_BROWSER_KEY = "pv_x";

/** Whether this browser was opted out of traffic analytics. Never throws. */
export function isInternalBrowser(): boolean {
  try {
    return localStorage.getItem(INTERNAL_BROWSER_KEY) === "1";
  } catch {
    return false;
  }
}

/** Query parameters worth keeping when a URL leaves for a third party: campaign tags only. */
const VENDOR_KEPT_PARAMS = ["utm_source", "utm_medium", "utm_campaign"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A path segment that identifies a record or carries a credential rather than naming a
 * page: a uuid, a bare number, or any long run of id characters with a digit in it (share
 * and scan tokens, Clerk user ids). Page names are short words, so none of them match.
 */
export function isIdSegment(segment: string): boolean {
  if (UUID.test(segment)) return true;
  if (/^\d+$/.test(segment)) return true;
  return segment.length >= 16 && /\d/.test(segment) && /^[A-Za-z0-9_-]+$/.test(segment);
}

/**
 * The address Vercel's analytics scripts are allowed to see, or null to drop the event.
 *
 * Both `<Analytics />` and `<SpeedInsights />` report the page's FULL URL by default — for
 * client-side transitions too. Orbit's own pipeline stores patterns, never paths, and that
 * was worth little while the same raw addresses went to Vercel: `/scan/<one-time token>`,
 * `/admin/users/<Clerk user id>`, every `/contacts/<uuid>`. This is the one place both
 * scripts pass through.
 *
 * - Untracked paths (the admin console, API routes) are dropped, not rewritten: the
 *   operator's own browsing is not traffic, and admin URLs carry other people's ids.
 * - Every id- or token-shaped segment becomes `[id]`, so an id or token never leaves.
 * - Every query parameter except the campaign tags is removed — sign-in redirects and
 *   one-off links carry ids and tickets in the query string, not just the path.
 */
export function redactUrlForVendor(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isTrackedPath(parsed.pathname)) return null;

  const path = parsed.pathname
    .split("/")
    .map((segment) => (segment && isIdSegment(decodeURIComponentSafe(segment)) ? "[id]" : segment))
    .join("/");

  const kept = new URLSearchParams();
  for (const key of VENDOR_KEPT_PARAMS) {
    const value = parsed.searchParams.get(key);
    if (value) kept.set(key, value);
  }
  const query = kept.toString();
  return `${parsed.origin}${path}${query ? `?${query}` : ""}`;
}

function decodeURIComponentSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
