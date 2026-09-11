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

/**
 * The one place a due date becomes words.
 *
 * Four surfaces formatted due dates and all four disagreed. The reminder card and the
 * dashboard row each compared timestamps and then floored the age up with
 * `Math.max(1, ...)`, so anything due earlier today read "Overdue 1 day" — a reminder set
 * for this morning, and eight follow-ups generated three seconds ago, all claimed to be a
 * day late. The dashboard had a "Due today" branch that was unreachable because the
 * overdue check ran first. The notification panel dropped the word "Overdue" entirely and
 * rendered a bare "8 months ago", which reads as a past event rather than a missed
 * deadline.
 *
 * `tone` is returned rather than a class name so each surface keeps its own styling.
 */
export type DueTone = "overdue" | "today" | "upcoming";

export function formatDueLabel(
  due: Date | string | null | undefined,
  now: Date = new Date()
): { text: string; tone: DueTone; days: number } | null {
  if (!due) return null;
  const d = due instanceof Date ? due : new Date(due);
  if (Number.isNaN(d.getTime())) return null;

  const days = calendarDaysBetween(now, d);

  if (days < 0) {
    const n = Math.abs(days);
    return {
      text: n === 1 ? "Overdue 1 day" : `Overdue ${n} days`,
      tone: "overdue",
      days,
    };
  }
  if (days === 0) return { text: "Due today", tone: "today", days };
  if (days === 1) return { text: "Due tomorrow", tone: "upcoming", days };
  if (days < 7) return { text: `Due in ${days} days`, tone: "upcoming", days };
  if (days < 14) return { text: "Due next week", tone: "upcoming", days };

  // Beyond a fortnight the exact day stops being the useful unit; months read better.
  const months = Math.round(days / 30);
  if (days < 60) return { text: `Due in ${Math.round(days / 7)} weeks`, tone: "upcoming", days };
  return { text: `Due in ${months} months`, tone: "upcoming", days };
}

/**
 * The absolute date to show alongside a relative label.
 *
 * Two reminders on the same calendar day rendered "Due in about 4 hours" and "Due in
 * about 24 hours", which made a list of them unreadable. Pairing the relative phrase with
 * a real date fixes that without losing the at-a-glance urgency.
 */
export function formatAbsoluteDay(
  due: Date | string | null | undefined,
  locale?: string
): string | null {
  if (!due) return null;
  const d = due instanceof Date ? due : new Date(due);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
}
