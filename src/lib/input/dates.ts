/**
 * Dates that arrive from a client: a server action argument, a form field, a cursor.
 *
 * `new Date(input)` never throws — it returns an Invalid Date, and the throw comes later,
 * from deep inside the driver (`toISOString()` → `RangeError: Invalid time value`), as an
 * opaque 500 that reaches Sentry as Orbit's fault (audit M-04). These helpers decide at the
 * boundary instead, and the `require*` forms throw a `UserFacingError` with the field's name.
 *
 * Pure and dependency-free: imported by actions, lib writers and pure smoke tests alike.
 */
import { UserFacingError } from "@/lib/errors";

/**
 * Years outside this range are not dates a person meant. `new Date("99999999999999999")`
 * parses as a valid instant in the year 275760 and Postgres refuses it; a reminder in the
 * year 3 is a typo. Generous on purpose: historical "date met" values and long-range
 * reminders both fit.
 */
const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

/** A valid Date in a sane range, or null. Accepts a Date, an ISO string or a date-only string. */
export function parseClientDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  let d: Date;
  if (value instanceof Date) d = new Date(value.getTime());
  else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 64) return null;
    d = new Date(trimmed);
  } else if (typeof value === "number") d = new Date(value);
  else return null;
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  return d;
}

/**
 * An optional client date: absent (`undefined`/`null`/`""`) → `null`; present but unreadable
 * → a `UserFacingError` naming the field, never a driver `RangeError`.
 */
export function optionalClientDate(value: unknown, field = "date"): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = parseClientDate(value);
  if (!d) throw new UserFacingError(`That ${field} doesn't look right`);
  return d;
}

/** A required client date: absent or unreadable → a `UserFacingError` naming the field. */
export function requireClientDate(value: unknown, field = "date"): Date {
  const d = parseClientDate(value);
  if (!d) throw new UserFacingError(`That ${field} doesn't look right`);
  return d;
}
