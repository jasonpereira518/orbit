"use client";

import { useEffect } from "react";
import { HEARTBEAT_INTERVAL_MS } from "@/lib/presence-window";
import { isOffline, reportRequestError, reportRequestOk } from "@/lib/connectivity-store";
import { syncTimeZoneCookie } from "@/lib/tz-cookie";
import { isIdle, onResume, touch } from "@/lib/idle-gate";

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
 * AND ONLY WHILE USED: a visible tab with no input for `IDLE_AFTER_MS` stops beating (the
 * timer ticks but skips), and the first input after that beats at once. Without this a
 * forgotten visible tab wakes a function every interval forever.
 *
 * Fire-and-forget: `keepalive` lets a beat survive the page unloading, failures are
 * ignored, and there is no retry. The cost of a lost beat is one interval of resolution on
 * an admin screen, and the next one is already scheduled.
 */
export function PresenceHeartbeat() {
  useEffect(() => {
    // Rides along app-wide: the server reads this cookie as the user's zone (`viewerTimeZone`).
    syncTimeZoneCookie();
    let timer: ReturnType<typeof setInterval> | null = null;

    const beat = () => {
      // Offline, a beat cannot land; the next one after reconnecting will.
      if (isOffline()) return;
      void fetch("/api/presence", {
        method: "POST",
        keepalive: true,
        cache: "no-store",
      }).then(reportRequestOk, reportRequestError);
    };

    const start = () => {
      if (timer !== null) return;
      touch(); // Showing the tab counts as being there, and beats right now.
      beat();
      timer = setInterval(() => {
        if (!isIdle()) beat();
      }, HEARTBEAT_INTERVAL_MS);
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
    const offResume = onResume(() => {
      if (document.visibilityState === "visible") beat();
    });

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      offResume();
      stop();
    };
  }, []);

  return null;
}
