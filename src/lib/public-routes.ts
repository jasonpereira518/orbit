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
  // Clicked from an email, by someone who has never signed in. Authenticated by the
  // opaque token in the query string instead, same pattern as the calendar feed above.
  "/api/interest-list/unsubscribe",
  // Not actually public: these authenticate via requireExtensionUserId, which reads the
  // Clerk state clerkMiddleware populates. They are exempted from auth.protect() only so
  // an unauthenticated call gets a JSON 401 the extension can act on, rather than a 302
  // to an HTML sign-in page.
  "/api/extension(.*)",
  // Not actually public either: Orbit's internal job routes. Vercel Cron, the ops scheduler
  // and the app's own self-continuation `fetch` carry no Clerk session, so `auth.protect()`
  // would bounce every one of them before the handler ran — which is exactly what happened,
  // silently, until Sept 2026. They authenticate with CRON_SECRET via `isInternalRequest()`
  // (`src/lib/internal-auth.ts`), which is fail-closed in production.
  "/api/imports/process-stalled",
  "/api/imports/(.*)/continue",
  "/api/embeddings/backfill",
  "/api/linkedin/timeline-events/backfill",
] as const;
