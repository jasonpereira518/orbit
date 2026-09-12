"use client";

import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { formatAbsoluteDay } from "@/lib/dates";

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
 */
export function RelativeTime({
  date,
  className,
}: {
  date: Date | string | number;
  className?: string;
}) {
  const value = date instanceof Date ? date : new Date(date);
  const absolute = formatAbsoluteDay(value) ?? "";
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
