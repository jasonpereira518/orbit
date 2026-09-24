"use client";

import { useEffect, useState } from "react";
import { formatTicketNumber } from "@/lib/interest-list";

const KEY_PREFIX = "waitlist:last-position:";

/**
 * "You moved up 42 places since your last visit." Remembers the place this browser last
 * saw for this pass and compares on the next visit. Per viewer and best-effort by design:
 * storage can be empty, blocked or throw (private windows, cleared data), and then this
 * renders nothing. Only ever good news — a place that got worse is recorded, not announced.
 *
 * Read after mount so the server HTML and the first client render agree.
 */
export function MovedUp({ shareToken, position }: { shareToken: string; position: number }) {
  const [moved, setMoved] = useState(0);

  useEffect(() => {
    const key = `${KEY_PREFIX}${shareToken}`;
    try {
      const stored = window.localStorage.getItem(key);
      const previous = stored === null ? NaN : Number(stored);
      if (Number.isFinite(previous) && previous > position) setMoved(previous - position);
      window.localStorage.setItem(key, String(position));
    } catch {
      // Storage unavailable: nothing to compare against, nothing to say.
    }
  }, [shareToken, position]);

  if (moved <= 0) return null;
  return (
    <p role="status" className="mt-2 text-sm text-landing-accent">
      You moved up {formatTicketNumber(moved)} {moved === 1 ? "place" : "places"} since your last
      visit.
    </p>
  );
}
