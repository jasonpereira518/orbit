const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days between two instants, or null when `from` is missing.
 *
 * Time is injected rather than read from the clock: `daysAgo()` in `duplicates.ts`
 * calls `Date.now()` internally, which makes every source that used it untestable
 * without freezing global time.
 */
export function daysBetween(from: Date | null | undefined, to: Date): number | null {
  if (!from) return null;
  return Math.floor((to.getTime() - new Date(from).getTime()) / DAY_MS);
}

/** Whether two dates fall on the same month and day, ignoring year. */
export function sameMonthDay(a: Date, month: number, day: number): boolean {
  return a.getMonth() + 1 === month && a.getDate() === day;
}

/** Midnight-anchored copy, so `due_on` is a calendar day rather than an instant. */
export function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}
