"use client";

import { useEffect } from "react";
import { HEARTBEAT_INTERVAL_MS } from "@/lib/presence-window";

/**
 * Tells the server this tab is still open and being used.
 *
 * Renders nothing. Mounted once in `(app)/layout.tsx`, so it covers the whole authenticated
 * shell and there is exactly one beat per tab regardless of how many routes are nested
 * below it.
 *
 * ONLY WHILE VISIBLE, which is the whole design. A backgrounded tab left open for three
 * days is not a person using Orbit, and counting it would make "active now" mean "has a
 * browser open somewhere", which is not a question worth answering. Hiding the tab stops
 * the beats; showing it beats immediately rather than waiting out the interval, so a user
 * returning to a tab reappears in the roster within a second instead of within a minute.
 *
 * Fire-and-forget: `keepalive` lets a beat survive the page unloading, failures are
 * ignored, and there is no retry. The cost of a lost beat is one interval of resolution on
 * an admin screen, and the next one is already scheduled.
 */
export function PresenceHeartbeat() {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const beat = () => {
      void fetch("/api/presence", {
        method: "POST",
        keepalive: true,
        cache: "no-store",
      }).catch(() => {});
    };

    const start = () => {
      if (timer !== null) return;
      beat();
      timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
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
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, []);

  return null;
}
