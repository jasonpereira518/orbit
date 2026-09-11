/**
 * Calendar-day helpers.
 *
 * These live here rather than in `@/lib/suggested-reminder-utils` (which still
 * re-exports them) because that module imports `node:crypto` and so cannot be
 * pulled into a client component. Date formatting is needed on both sides.
 */

/** Formats a Date as YYYY-MM-DD in the *local* calendar, never UTC. */
export function isoDay(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Parses YYYY-MM-DD at local noon. Never `new Date(iso)`, which parses as UTC and can
 * land on the previous calendar day for western timezones.
 *
 * Noon rather than midnight so that a DST transition — which moves the clock by an
 * hour, not twelve — cannot push the value onto an adjacent day either.
 */
export function isoDayToLocalNoon(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0, 0);
}

/**
 * Whether a date-like value is a bare calendar day (`YYYY-MM-DD`) rather than a
 * full timestamp. Date inputs (`<input type="date">`) always submit this shape,
 * and it is the shape that must go through `isoDayToLocalNoon`.
 */
export function isCalendarDayString(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/**
 * Parses whatever a form or API hands us into a Date, without the UTC-midnight trap.
 *
 * A bare `YYYY-MM-DD` is interpreted in the user's own calendar; anything else
 * (an ISO timestamp, an RFC string) is left to the platform parser, which is
 * unambiguous once a time and offset are present.
 */
export function parseDueDateInput(value: string): Date {
  const trimmed = value.trim();
  return isCalendarDayString(trimmed)
    ? isoDayToLocalNoon(trimmed)
    : new Date(trimmed);
}

/** Start of the local calendar day containing `d`. */
export function startOfLocalDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/**
 * Whole calendar days from `from` to `to`, ignoring clock time.
 *
 * Compares day boundaries rather than subtracting milliseconds and flooring, so a
 * reminder due at 09:00 today reads as 0 days from 17:00 today — not -1 — and
 * "due today" never has to be recovered from a rounding artifact.
 */
export function calendarDaysBetween(from: Date, to: Date) {
  const a = startOfLocalDay(from).getTime();
  const b = startOfLocalDay(to).getTime();
  return Math.round((b - a) / 86_400_000);
}
