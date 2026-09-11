/**
 * Which callers are demo accounts. Dependency-free on purpose: `entitlements.ts` needs this
 * and runs in background jobs and tsx scripts, where `auth.ts` (Clerk, `next/navigation`)
 * must not be dragged in. `auth.ts` re-exports the two mode checks, so existing callers keep
 * importing them from there.
 */

export function isClerkConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
}

/**
 * Running on a local dev server (`next dev`). Keyed off `NODE_ENV` rather than the request
 * host so background jobs and scripts, which have no request, resolve the same way —
 * and because `next dev` is never what a deployment runs.
 */
export function isLocalhost() {
  return process.env.NODE_ENV === "development";
}

/** Local dev without Clerk keys — shared demo-user data. */
export function isDemoMode() {
  return !isClerkConfigured() && isLocalhost();
}

/**
 * The Clerk id of the showcase account live demos run from, or null when none is
 * configured. `env.ts` forbids `DEMO_ACCOUNT_USER_ID` in production, so this is always null
 * there.
 */
export function getShowcaseAccountId(): string | null {
  return process.env.DEMO_ACCOUNT_USER_ID?.trim() || null;
}

/**
 * A demo account is one that exists to show the product, so no plan gate should ever stand
 * in front of it:
 *
 *   - every account on localhost, Clerk-signed-in or the shared `demo-user` alike.
 *   - the showcase account named by `DEMO_ACCOUNT_USER_ID`, wherever it runs.
 *
 * Nothing else. In particular a Clerk-less deploy that isn't `next dev` gets no exemption:
 * it would put every anonymous visitor on the shared `demo-user` with paid access.
 */
export function isDemoAccount(userId: string | null | undefined): boolean {
  if (!userId) return false;
  if (isLocalhost()) return true;
  return userId === getShowcaseAccountId();
}
