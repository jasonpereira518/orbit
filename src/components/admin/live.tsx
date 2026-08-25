"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { LiveScreen, LiveValues } from "@/lib/admin-live-tiers";

/**
 * Keeps a console screen's numbers current without reloading it.
 *
 * WHY NOT `router.refresh()`. The obvious way to make a server-rendered screen update is
 * to refresh the route on a timer, but that re-runs every query behind the page and
 * replaces the whole tree — filters flicker, scroll position fights the operator, and a
 * `⋯` menu closes itself while being read. This fetches a flat record of scalars and
 * repaints the digits inside nodes that already exist.
 *
 * WHY NOT SSE OR A WEBSOCKET. Same information, considerably more infrastructure, on a
 * console with one user. If this ever drives hundreds of rows, revisit; today a poll is
 * the honest choice. (The same reasoning `presence.tsx` records, for the same reason.)
 *
 * THE RULE THIS ENFORCES: a live update may replace text inside an existing node and
 * resize a bar. It may NOT add, remove or reorder a row. Nothing may move while it is
 * being read, so lists and tables stay exactly as the server rendered them — see
 * `admin-live.ts` for what is deliberately excluded on those grounds.
 *
 * One interval per screen no matter how many values render, paused while the tab is
 * hidden, and the last known values are kept when a poll fails: "briefly stale" reads far
 * better than every number on the screen dropping to zero at once.
 */

const LiveContext = createContext<LiveValues>({});

export function LiveProvider({
  screen,
  intervalMs,
  initial,
  children,
}: {
  screen: LiveScreen;
  /** From `SCREEN_TIER` — passed in so the cadence is visible at the call site. */
  intervalMs: number;
  /** The server-rendered values, so the first paint is already correct. */
  initial: LiveValues;
  children: React.ReactNode;
}) {
  const [values, setValues] = useState<LiveValues>(initial);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(`/api/admin/live/${screen}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { values?: LiveValues };
        if (cancelled || !data.values) return;
        // Merged, not replaced: a partial payload must not blank the values it omits.
        setValues((prev) => ({ ...prev, ...data.values }));
      } catch {
        // Keep the last known values rather than zeroing the screen on one failed poll.
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
  }, [screen, intervalMs]);

  return <LiveContext.Provider value={values}>{children}</LiveContext.Provider>;
}

export function useLiveValue(name: string): number | string | null | undefined {
  return useContext(LiveContext)[name];
}

/**
 * One live figure.
 *
 * Falls back to `children` — the server-rendered value — whenever the live record has
 * nothing for this name, so a screen with no provider, a failed first poll, or a value
 * the endpoint does not publish all render exactly what they render today.
 *
 * A changed value flashes once, briefly. Without it a number that moves while the
 * operator is looking elsewhere is indistinguishable from one that was always that; with
 * anything stronger the console would twitch all afternoon. Respects reduced motion.
 */
export function LiveValue({
  name,
  children,
  className,
}: {
  name: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const value = useLiveValue(name);
  const [flash, setFlash] = useState(false);
  const previous = useRef<number | string | null | undefined>(undefined);

  useEffect(() => {
    if (value === undefined) return;
    if (previous.current !== undefined && previous.current !== value) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 700);
      previous.current = value;
      return () => clearTimeout(t);
    }
    previous.current = value;
  }, [value]);

  const shown = value === undefined || value === null ? children : value;

  return (
    <span
      className={cn(
        "tabular-nums transition-colors duration-slow ease-house",
        flash && "text-primary motion-reduce:transition-none",
        className
      )}
    >
      {shown}
    </span>
  );
}
