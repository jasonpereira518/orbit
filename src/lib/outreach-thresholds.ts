/**
 * When a relationship counts as quiet, shared by the dashboard's outreach suggestions
 * (`src/lib/reminders.ts`) and Radar's scorer (`src/lib/radar/score.ts`).
 *
 * Pure: no imports. Both consumers must agree on these numbers, or the dashboard and Radar
 * would disagree about who has gone quiet during the months they run side by side.
 */

/**
 * How long without a touch counts as dormant, when the person never said otherwise.
 *
 * A stated cadence replaces this per contact: somebody you agreed to speak with quarterly is
 * not dormant on day 31, and telling them they have "gone quiet" on schedule is how a
 * suggestion queue loses credibility.
 */
export const DORMANT_DAYS = 30;

/**
 * How long a LinkedIn thread sits before it counts as gone quiet.
 *
 * Only the LOWER bound is cadence-aware. The upper bound (90 days) exists to stop ancient
 * threads resurfacing forever and has nothing to do with an agreed rhythm, so a quarterly
 * cadence must not drag it out to a year. Asymmetric on purpose.
 */
export const LINKEDIN_QUIET_MIN_DAYS = 14;
export const LINKEDIN_QUIET_MAX_DAYS = 90;

/**
 * The idle window a contact's own cadence supplies, clamped to what the column allows.
 * Null-safe: a contact who never stated one falls back to the caller's default.
 */
export function idleThresholdFor(cadenceDays: number | null | undefined, fallback: number) {
  return typeof cadenceDays === "number" && cadenceDays > 0 ? cadenceDays : fallback;
}
