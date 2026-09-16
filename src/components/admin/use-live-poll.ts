"use client";

import { useEffect, useState } from "react";

/**
 * Generic narrow-polling for an admin screen: seeded from the server so first paint is
 * already correct, refetched on an interval, paused while the tab is hidden, and left
 * alone (not blanked) on a failed poll. See `presence.tsx` for the fuller rationale —
 * WHY NOT `router.refresh()`, WHY NOT SSE/websockets — which applies here unchanged.
 *
 * Resyncs to `initial` whenever it changes identity, which happens exactly when the
 * server actually re-rendered this route (typically `router.refresh()` after a mutation
 * made from this same page, e.g. an admin's own "Retry"/"Disconnect" click). Without
 * this, a fresh server value would sit ignored until the next poll tick, and the action
 * that just ran would look like it silently did nothing for up to `intervalMs`.
 */
export function useLivePoll<T>(url: string, initial: T, intervalMs: number): T {
  const [data, setData] = useState<T>(initial);

  useEffect(() => {
    setData(initial);
  }, [initial]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as T;
        if (!cancelled) setData(json);
      } catch {
        // Keep the last known value — a briefly stale read is better than blanking the
        // screen on one dropped poll.
      }
    };

    const start = () => {
      if (timer !== null) return;
      void poll();
      timer = setInterval(() => void poll(), intervalMs);
    };

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, [url, intervalMs]);

  return data;
}
