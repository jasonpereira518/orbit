/**
 * Routes reachable without a Clerk session.
 *
 * Kept out of `proxy.ts` so it can be asserted against the filesystem: every page under
 * `src/app/(site)/` and `src/app/(clerk)/(marketing)/` must appear here. A marketing page
 * missing from this list is
 * served only to signed-in users, which means the visitors it exists to convert get a
 * 404 — and only in production, since the middleware skips protection entirely when
 * Clerk is unconfigured locally. `scripts/smoke-public-routes.ts` enforces it.
 */
export const PUBLIC_ROUTES = [
  "/",
  "/pricing",
  // The standalone interest-list page. Its form posts to a server action, which is not
  // matched here — actions POST to the page's own URL, so a public page covers them.
  "/interest",
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
  // The boarding-pass link preview. Fetched by X, LinkedIn and iMessage, which carry no
  // session; authenticated by nothing, because it reveals only a number and a planet.
  "/api/interest-list/ticket-image",
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
  // The capture job runner's internal kick — same gate, same reasons.
  "/api/capture/jobs/(.*)/run",
  "/api/embeddings/backfill",
  "/api/linkedin/timeline-events/backfill",
  "/api/ops/sweep",
  "/api/sync/run",
  "/api/webhooks/outbound/drain",
  // Not public either: the API and MCP surfaces authenticate with a per-user API key
  // (`src/lib/api/auth.ts`), which Clerk knows nothing about. Exempted from
  // auth.protect() only so an unauthenticated call gets a JSON 401 a client can act on
  // rather than a 302 to an HTML sign-in page — the same reason /api/extension is here.
  // The key check is fail-closed and rejects a malformed bearer before any database work.
  "/api/v1(.*)",
  "/api/mcp(.*)",
  // Genuinely public: browsers POST Content-Security-Policy violation reports here with
  // no session. The handler stores nothing but a directive and a URI, throttled.
  "/api/csp-report",
  // Genuinely public: the traffic beacon. Anonymous marketing visitors are most of what
  // it exists to count, so requiring a session would measure only the people who already
  // converted. It stores no IP and sets no cookie — see src/lib/analytics-visitor.ts.
  "/api/track",
  // Genuinely public: the liveness probe the uptime monitor polls. Its shallow body says
  // only "up or down" plus the deployed sha; the deep view needs HEALTH_TOKEN.
  "/api/health",
  // The phone half of note scanning. A phone that has never signed in opens this from a QR
  // code on a signed-in desktop, and is authenticated solely by the opaque token in the
  // path (`src/lib/scan-handoff.ts`) — the same arrangement as the calendar feed above.
  // Requiring a Clerk session here would defeat the point: the entire feature exists so
  // nobody has to sign into a CRM on a phone keyboard to photograph a page of notes.
  // The token is single-use, expires in ten minutes, is stored only as a SHA-256 hash, and
  // is checked against a shape regex before any query, so malformed traffic costs nothing.
  "/scan/(.*)",
  "/api/scan/(.*)",
] as const;
