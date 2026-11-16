"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RadarRunProgress } from "@/lib/radar/page-data";

const POLL_MS = 800;

async function fetchProgress(): Promise<RadarRunProgress | null> {
  try {
    const res = await fetch("/api/radar/status", { cache: "no-store" });
    return res.ok ? ((await res.json()) as RadarRunProgress) : null;
  } catch {
    return null; // Offline or a blip: keep the last value and try again on the next tick.
  }
}

/**
 * Where the account's Radar run is, for "Refresh now".
 *
 * `watch("own")`: this tab started the run. The action's own result ends it (`stop()`), and the
 * poll only draws the bar, so it ignores the previous run still sitting there as the newest row
 * until the new one is created.
 * `watch("attach")`: something else is running (the nightly pass, a page-triggered rebuild, a
 * click in another tab). The poll itself notices it end and calls `onFinished`.
 *
 * Once on mount it checks whether a run is already going, which is how landing on /radar
 * mid-run shows the bar. Polls over `fetch`: a Server Action would queue behind the refresh.
 */
export function useRadarRunProgress(onFinished: (status: RadarRunProgress["status"]) => void) {
  const [snap, setSnap] = useState<RadarRunProgress | null>(null);
  const [mode, setMode] = useState<"own" | "attach" | null>(null);
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  });

  const watch = useCallback((next: "own" | "attach") => {
    setSnap(null);
    setMode(next);
  }, []);
  const stop = useCallback(() => {
    setMode(null);
    setSnap(null);
  }, []);

  useEffect(() => {
    let live = true;
    void fetchProgress().then((s) => {
      if (live && s?.running) {
        setSnap(s);
        setMode((current) => current ?? "attach");
      }
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!mode) return;
    let live = true;
    const tick = async () => {
      const s = await fetchProgress();
      if (!live || !s) return;
      if (s.running) setSnap(s);
      else if (mode === "attach") {
        setSnap(null);
        setMode(null);
        finished.current(s.status);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [mode]);

  return { snap, watching: mode !== null, watch, stop };
}
