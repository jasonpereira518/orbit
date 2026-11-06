"use client";

import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { formatAbsoluteDay, formatAbsoluteDayUtc } from "@/lib/dates";

/**
 * A timestamp that reads as "11 minutes ago" without breaking hydration.
 *
 * `formatDistanceToNow` is a function of *now*, so a server render and the client
 * hydration that follows it disagree whenever a minute ticks over in between — which,
 * for any list older than a minute, is most loads. `/imports` threw
 * "Hydration failed because the server rendered text didn't match the client" on a
 * perfectly ordinary page view: the server said "10 minutes ago", the browser said 11.
 *
 * The fix is to make the FIRST client render match the server by construction. Both
 * produce the absolute date — which depends only on the timestamp, not on when it was
 * rendered — and the relative phrase is swapped in after mount, where React is free to
 * update the DOM normally.
 *
 * `suppressHydrationWarning` would have silenced the message while leaving the stale
 * server text in place; this shows the right value instead.
 *
 * The absolute fallback is pinned to en-US/UTC (`formatAbsoluteDayUtc`) rather than left to
 * `toLocaleDateString`'s defaults, which read the RUNTIME's locale and timezone — "Sep 15"
 * on the server against "15 Sep" in the browser, and worse, a different DAY either side of a
 * timezone boundary. That put the mismatch straight back into the component built to remove
 * it, for everyone outside en-US/UTC. It is only ever a placeholder: the effect below
 * replaces it on mount.
 */
export function RelativeTime({
  date,
  className,
}: {
  date: Date | string | number;
  className?: string;
}) {
  const value = date instanceof Date ? date : new Date(date);
  const absolute = formatAbsoluteDayUtc(value) ?? "";
  const [label, setLabel] = useState(absolute);

  useEffect(() => {
    if (Number.isNaN(value.getTime())) return;
    setLabel(formatDistanceToNow(value, { addSuffix: true }));
  }, [value]);

  if (Number.isNaN(value.getTime())) return null;

  return (
    // The machine-readable value stays exact whichever label is showing.
    <time dateTime={value.toISOString()} title={value.toLocaleString()} className={className}>
      {label}
    </time>
  );
}

/**
 * A date as the reader's own calendar shows it, without a hydration mismatch.
 *
 * Same two-step as `RelativeTime` and for the same reason: the server cannot know the
 * viewer's timezone, so it renders the UTC day and the browser swaps in the local one after
 * mount. Unlike `RelativeTime`, the absolute day is the FINAL text here rather than a
 * placeholder for a relative phrase, so the swap is what makes it correct as well as
 * consistent — a reminder due late on the 15th UTC reads as the 16th for a reader in Berlin,
 * which is the day it is actually due for them.
 */
export function AbsoluteDay({
  date,
  className,
  prefix,
}: {
  date: Date | string | number | null | undefined;
  className?: string;
  /** Rendered only when there is a day to show, so a separator never dangles alone. */
  prefix?: string;
}) {
  // Normalised once so the two formatters see the same value and `number` is accepted here
  // as it is on `RelativeTime`.
  const value = date == null ? null : date instanceof Date ? date : new Date(date);
  const [label, setLabel] = useState(() => formatAbsoluteDayUtc(value));

  useEffect(() => {
    setLabel(formatAbsoluteDay(value));
  }, [value]);

  if (!label) return null;
  return (
    <span className={className}>
      {prefix}
      {label}
    </span>
  );
}
