/**
 * The route vocabulary for traffic analytics — every path the beacon may record, as a
 * PATTERN rather than a pathname.
 *
 * Two jobs, and the second one matters more than the first.
 *
 * CARDINALITY: `/contacts/<uuid>` is a different string for every contact in every
 * account. Storing raw paths would make "top pages" a list of a thousand rows with a
 * count of one, and the GROUP BY behind it would grow without bound.
 *
 * CONTAINMENT: those uuids are contact ids. `page_views` is an aggregate reporting table
 * that the admin console reads across all accounts — it has no business holding a
 * per-record identifier, and once one leaks in, deleting a contact no longer deletes
 * every trace of it. Normalising at ingest is the only place this can be enforced, so it
 * happens server-side in `POST /api/track` and the client's opinion is never consulted.
 *
 * Kept as a plain list, deliberately, so `scripts/smoke-admin-analytics.ts` can assert it
 * against the filesystem the way `scripts/smoke-public-routes.ts` does for
 * `PUBLIC_ROUTES`. A page added without a pattern here lands in `/unknown` and silently
 * disappears from the reporting — the smoke test is what turns that into a failed build.
 */

/**
 * Every trackable route. `[x]` matches exactly one segment; `[[...x]]` matches zero or
 * more trailing segments. Admin routes are absent on purpose — see `isTrackedPath`.
 */
export const ROUTE_PATTERNS: readonly string[] = [
  // Marketing
  "/",
  "/pricing",
  "/interest",
  "/privacy",
  "/terms",
  "/contact",
  // Auth — tracked, because they are funnel steps
  "/sign-in/[[...sign-in]]",
  "/sign-up/[[...sign-up]]",
  // Checkout
  "/upgrade",
  // The phone side of a scan handoff. The segment is a one-time credential, which is one
  // more reason the stored route must be the pattern and never the path.
  "/scan/[token]",
  // Account states
  "/suspended",
  "/onboarding",
  "/onboarding/wizard",
  "/settings",
  // Product
  "/dashboard",
  "/capture",
  "/capture/[batchId]",
  "/chat",
  "/contacts",
  "/contacts/new",
  "/contacts/duplicates",
  "/contacts/[id]",
  "/events",
  "/events/[id]",
  "/graph",
  "/imports",
  "/knowledge",
  "/outreach",
  "/outreach/new",
  "/outreach/[id]",
  "/recruiters",
  "/recruiters/new",
  "/recruiters/compose",
  "/recruiters/[id]",
  "/reminders",
] as const;

/** What an unrecognised path becomes. One bucket, so cardinality stays bounded even here. */
export const UNKNOWN_ROUTE = "/unknown";

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

const isDynamic = (seg: string) => seg.startsWith("[") && seg.endsWith("]");
const isCatchAll = (seg: string) => seg.startsWith("[[...") || seg.startsWith("[...");

/**
 * Score a pattern against a path, or null if it does not match.
 *
 * Higher is better, and a static segment always outscores a dynamic one at the same
 * depth — that is what makes `/contacts/new` win over `/contacts/[id]` for `/contacts/new`
 * regardless of the order the two appear in the list above.
 */
function score(pattern: string, path: string): number | null {
  const pat = segments(pattern);
  const seg = segments(path);

  let points = 0;
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i];
    if (isCatchAll(p)) {
      // An optional catch-all matches whatever is left, including nothing at all.
      return points + 1;
    }
    if (i >= seg.length) return null;
    if (isDynamic(p)) {
      points += 1;
      continue;
    }
    if (p !== seg[i]) return null;
    points += 10;
  }
  return pat.length === seg.length ? points : null;
}

/**
 * Map a real pathname onto one of `ROUTE_PATTERNS`, or `UNKNOWN_ROUTE`.
 *
 * SERVER-SIDE ONLY. The beacon sends the pathname it observed; this decides what gets
 * stored. Trusting a client-supplied pattern would hand anyone with curl the ability to
 * write arbitrary high-cardinality strings into the column every aggregate groups by.
 */
export function normalizeRoute(pathname: string): string {
  const clean = (pathname.split("?")[0] ?? "").split("#")[0] ?? "";
  if (!clean.startsWith("/")) return UNKNOWN_ROUTE;

  let best: string | null = null;
  let bestScore = -1;
  for (const pattern of ROUTE_PATTERNS) {
    const s = score(pattern, clean);
    if (s !== null && s > bestScore) {
      best = pattern;
      bestScore = s;
    }
  }
  return best ?? UNKNOWN_ROUTE;
}

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

/** Query parameters worth keeping when a URL leaves for a third party: campaign tags only. */
const VENDOR_KEPT_PARAMS = ["utm_source", "utm_medium", "utm_campaign"] as const;

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
 * - The path becomes its `ROUTE_PATTERNS` entry, so an id or token never leaves.
 * - Every query parameter except the campaign tags is removed — sign-in redirects and
 *   one-off links carry ids and tickets in the query string, not just the path.
 *
 * Pure and dependency-free, like the rest of this module, because it runs in the browser.
 */
export function redactUrlForVendor(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isTrackedPath(parsed.pathname)) return null;

  const kept = new URLSearchParams();
  for (const key of VENDOR_KEPT_PARAMS) {
    const value = parsed.searchParams.get(key);
    if (value) kept.set(key, value);
  }
  const query = kept.toString();
  return `${parsed.origin}${normalizeRoute(parsed.pathname)}${query ? `?${query}` : ""}`;
}
