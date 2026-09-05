import { differenceInCalendarDays } from "date-fns";

/**
 * Date grammar for the contact timeline.
 *
 * Everything here is measured in **calendar days**, never elapsed milliseconds. The timeline is
 * a client component rendered on the server first, so a minute-granularity relative label
 * ("less than a minute ago") is guaranteed to disagree with itself across hydration. A calendar
 * -day label only changes at midnight, which makes it stable for the life of a request.
 *
 * The absolute date is never lost — the row still carries it in `<time dateTime>` and in the
 * element's `title`. This is the glanceable layer on top of it.
 */
export function timelineDayLabel(
  value: Date | string,
  now: Date = new Date()
): string {
  const days = differenceInCalendarDays(now, new Date(value));

  // Interactions can legitimately be dated ahead: a meeting logged the morning it happens, in
  // a timezone behind the server's.
  if (days < 0) {
    const ahead = Math.abs(days);
    return ahead === 1 ? "Tomorrow" : `In ${ahead} days`;
  }

  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;

  if (days < 31) {
    const weeks = Math.max(1, Math.round(days / 7));
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }

  if (days < 365) {
    const months = Math.max(1, Math.round(days / 30.44));
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }

  // Floored, not rounded: 20 months is "1 year ago", not "2 years ago".
  const years = Math.max(1, Math.floor(days / 365.25));
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

/** Below this, a gap between two interactions is just ordinary spacing and goes unremarked. */
const QUIET_GAP_DAYS = 60;

/**
 * The label for a silence between two interactions, or `null` if the gap is unremarkable.
 *
 * This is the honest version of what a time-proportional scrubber was reaching for. Spacing the
 * spine by elapsed time collapses a dense month into an unreadable smear and still cannot say
 * *how long* a gap was; a marker in the thread says it in words, and reads as narrative — you
 * scroll past "11 months quiet" and know something happened.
 */
export function timelineGapLabel(
  older: Date | string,
  newer: Date | string
): string | null {
  const days = differenceInCalendarDays(new Date(newer), new Date(older));
  if (days < QUIET_GAP_DAYS) return null;

  if (days < 365) {
    return `${Math.round(days / 30.44)} months quiet`;
  }

  const years = days / 365.25;
  if (years < 1.75) return "About a year quiet";
  return `${Math.round(years)} years quiet`;
}
