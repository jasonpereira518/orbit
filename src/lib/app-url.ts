/**
 * Resolves the app's public base URL.
 *
 * `VERCEL_PROJECT_PRODUCTION_URL` is preferred over `VERCEL_URL` because the latter is the
 * *per-deployment* host and changes on every deploy. That is harmless for internal
 * fire-and-forget fetches, but user-facing URLs (e.g. the calendar feed a user pastes into
 * Google Calendar once and never touches again) would silently point at a stale deployment.
 *
 * Set `APP_BASE_URL` in production to pin this explicitly.
 */
export function getAppBaseUrl() {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT || 3000}`;
}
