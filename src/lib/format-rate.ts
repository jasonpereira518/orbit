/**
 * The console's one rule for printing a ratio.
 *
 * Its own module, free of any import, because the Growth charts are client components and
 * need it in the tooltip. It used to live in `admin-analytics.ts`, which reaches `@/db` —
 * and a client component importing that fails the build with a `node:fs` chunking error
 * naming neither file. `admin-analytics.ts` re-exports both names, so server callers are
 * unchanged.
 */

/**
 * The minimum denominator a percentage is allowed to have.
 *
 * `/admin/growth` reports counts, not rates — "at this scale a percentage is two people
 * wearing a confidence interval". Some questions cannot be answered without a ratio
 * (conversion, stickiness, retention), so the compromise is this: every rate prints its
 * own fraction beside it, and below this many observations the percentage is withheld
 * entirely rather than dressing up a coin flip as a trend.
 */
export const MIN_RATE_DENOMINATOR = 30;

/** "9 of 14" — with "(64%)" appended only once the denominator can support it. */
export function formatRate(count: number, of: number | null): string {
  if (of == null || of === 0) return count.toLocaleString();
  const fraction = `${count.toLocaleString()} of ${of.toLocaleString()}`;
  if (of < MIN_RATE_DENOMINATOR) return fraction;
  return `${fraction} (${Math.round((count / of) * 100)}%)`;
}
