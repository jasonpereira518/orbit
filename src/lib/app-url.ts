import { waitlistOrigin } from "@/lib/waitlist-host";

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

/**
 * Where the waitlist's links and images point: its own domain when `WAITLIST_HOST` is set,
 * the app's origin otherwise (local development, previews). Everything a waitlist visitor
 * or recipient is handed — share and pass links, the leave link, the share image, the
 * planet art in the emails — is built on this, never on `getAppBaseUrl()`, because the
 * app's domain must not appear anywhere the waitlist reaches. See `lib/waitlist-host.ts`.
 */
export function getWaitlistOrigin() {
  return waitlistOrigin() ?? getAppBaseUrl();
}

/** The waitlist page itself: `/` on its own domain, `/interest` on the app's. */
export function getWaitlistPageUrl() {
  const origin = waitlistOrigin();
  return origin ? `${origin}/` : `${getAppBaseUrl()}/interest`;
}
