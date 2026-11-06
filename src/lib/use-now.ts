"use client";

import { useEffect, useState } from "react";

/**
 * The current time, refreshed every `intervalMs` — for "in 12 min" / "ended 3 min ago" copy.
 * Null until mounted, so the server render and hydration agree (and render nothing time-bound).
 * `enabled` false stops the timer for a component that has nothing to count down to.
 */
export function useNow(intervalMs: number, enabled = true): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return enabled ? now : null;
}
