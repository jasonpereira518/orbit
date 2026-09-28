/**
 * Admin console timestamps are Eastern Time, 12-hour clock.
 *
 * Operators read the console in one place; showing UTC ISO or browser-local times
 * forces mental conversion on every hover. `America/New_York` covers EST/EDT;
 * the short zone name in the formatted string makes which one explicit.
 */

export const ADMIN_TIME_ZONE = "America/New_York";

const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: ADMIN_TIME_ZONE,
  timeZoneName: "short",
});

const DATE_ONLY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: ADMIN_TIME_ZONE,
});

function asDate(value: Date | string | number): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Exact wall time for tooltips and absolute labels, e.g. "Sep 27, 2026, 7:55 PM EDT". */
export function formatAdminDateTime(value: Date | string | number): string {
  const d = asDate(value);
  return d ? DATE_TIME.format(d) : "—";
}

/** Calendar day in Eastern Time, e.g. "Sep 27, 2026". */
export function formatAdminDate(value: Date | string | number): string {
  const d = asDate(value);
  return d ? DATE_ONLY.format(d) : "—";
}
