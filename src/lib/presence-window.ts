/**
 * The presence timing constants, and the one pure predicate over them.
 *
 * SEPARATE FROM `presence.ts` FOR A CONCRETE REASON: the heartbeat client component needs
 * the interval, and `presence.ts` imports `@/db`. Importing the interval from there dragged
 * PGlite — and therefore `node:fs` — into the browser bundle, which Turbopack rejects at
 * build time with a chunking error that names neither the constant nor the database. This
 * file imports nothing at all, so it is safe from either side.
 *
 * Do not re-export these from `presence.ts`. A re-export would make the broken import path
 * compile again and reintroduce the same build failure the next time a client component
 * reaches for a constant.
 */

/**
 * How often a visible tab beats.
 *
 * 45s is chosen against the window below, not for its own sake: it gives every beat a full
 * spare interval of slack, so one dropped request — a sleeping radio, a redeploy, a
 * momentary offline — does not blink an active user out of the roster and back.
 */
export const HEARTBEAT_INTERVAL_MS = 45 * 1000;

/**
 * How recently a beat must have landed for the user to count as live. Exactly two
 * intervals; see above for why the ratio rather than the value is the design.
 *
 * Do not widen this "to be safe". A window much larger than the interval makes everyone who
 * used the app in the last few minutes permanently "active now", which is the failure mode
 * that makes a presence indicator worthless — it stops distinguishing anything.
 */
export const PRESENCE_WINDOW_MS = 2 * HEARTBEAT_INTERVAL_MS;

/** Is this timestamp recent enough to count as present? */
export function isLive(
  lastActiveAt: Date | null | undefined,
  now: Date = new Date()
): boolean {
  if (!lastActiveAt) return false;
  return now.getTime() - lastActiveAt.getTime() < PRESENCE_WINDOW_MS;
}
