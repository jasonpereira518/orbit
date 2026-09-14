import { track } from "@vercel/analytics/server";
import type { EventProps } from "@/lib/analytics-events";

/**
 * Server-side custom event, for the webhook handlers where no browser is present to fire
 * `trackEvent`. Split into its own module so `@vercel/analytics/server` never reaches a
 * client bundle — the same reasoning as the `db` client-bundle trap elsewhere in this repo.
 *
 * Always `await` this. `@vercel/analytics/server`'s `track()` either rides Vercel's
 * `waitUntil` (free when available) or awaits the send directly when that context is
 * absent — the only way the request isn't aborted mid-flight in that case. It also
 * silently no-ops (catches its own error) if no request/headers are passed, so `request`
 * is required here rather than left optional.
 */
export async function trackServerEvent<K extends keyof EventProps>(
  name: K,
  props: EventProps[K],
  request: { headers: Headers }
): Promise<void> {
  await track(name, props, { request });
}
