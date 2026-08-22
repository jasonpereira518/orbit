/**
 * Routes reachable without a Clerk session.
 *
 * Kept out of `proxy.ts` so it can be asserted against the filesystem: every page under
 * `src/app/(marketing)/` must appear here. A marketing page missing from this list is
 * served only to signed-in users, which means the visitors it exists to convert get a
 * 404 — and only in production, since the middleware skips protection entirely when
 * Clerk is unconfigured locally. `scripts/smoke-public-routes.ts` enforces it.
 */
export const PUBLIC_ROUTES = [
  "/",
  "/pricing",
  "/privacy",
  "/terms",
  "/contact",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks(.*)",
  // Calendar clients (Google, Apple, Outlook) cannot complete a Clerk session. The feed
  // is authenticated by the opaque token in its path instead.
  "/api/calendar/(.*)",
] as const;
