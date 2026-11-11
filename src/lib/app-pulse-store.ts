"use client";

import { useSyncExternalStore } from "react";
import { getAppPulse } from "@/actions/app-pulse";
import type { AppPulse } from "@/lib/app-pulse";
import { isOffline, reportRequestError, reportRequestOk } from "@/lib/connectivity-store";

/**
 * One poll for the whole app, shared by everything that used to poll on its own.
 *
 * Same shape as `src/lib/background-jobs.ts`: module-level state, one timer started by
 * the first subscriber and stopped by the last, in-flight requests shared, a sequence
 * guard so the newest response wins, and nothing fetched while the tab is hidden. The
 * notifications panel, the desktop-notification watcher and the plan-celebration watcher
 * all subscribe here instead of running their own 120 s / 90 s / 75 s timers.
 */
export const PULSE_MS = 90_000;

export type PulseSnapshot = { pulse: AppPulse | null; loading: boolean };

const EMPTY: PulseSnapshot = { pulse: null, loading: false };

let snapshot: PulseSnapshot = EMPTY;
let inFlight: Promise<void> | null = null;
let latest = 0;
let timer: number | null = null;
const listeners = new Set<() => void>();

function set(next: Partial<PulseSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const l of listeners) l();
}

/**
 * Ambient callers share whatever request is running. `force` is for right after a
 * mutation, which must not be served by a request issued before the mutation landed.
 */
export function refreshPulse(force = false): Promise<void> {
  if (inFlight && !force) return inFlight;
  const id = ++latest;
  const startedAt = Date.now();
  set({ loading: true });
  const run = getAppPulse()
    .then((pulse) => {
      reportRequestOk();
      if (id !== latest) return;
      // A read that set off before /radar's "opened" stamp landed still counts those cards
      // as new; it must not bring the nav pulse back.
      set({ pulse: startedAt < radarClearedAt + RADAR_STAMP_GRACE_MS ? { ...pulse, radarNew: 0 } : pulse });
    })
    .catch((err) => {
      // Network / auth blips: the next tick, the next page load, or `OfflineSync` on
      // reconnect gets it. The last good pulse stays on screen meanwhile.
      reportRequestError(err);
    })
    .finally(() => {
      if (id !== latest) return;
      inFlight = null;
      set({ loading: false });
    });
  inFlight = run;
  return run;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1 && timer === null) {
    timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !isOffline()) void refreshPulse();
    }, PULSE_MS);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      document.removeEventListener("visibilitychange", onVisible);
      // Dropped when the shell unmounts so the next session cannot paint the previous
      // account's counts before its own first fetch lands.
      snapshot = EMPTY;
    }
  };
}

function onVisible() {
  if (document.visibilityState === "visible" && !isOffline()) void refreshPulse();
}

/** /radar stamps "opened" after its response (`stampRadarOpened` in `after()`). */
const RADAR_STAMP_GRACE_MS = 5_000;
let radarClearedAt = 0;

/**
 * The person is looking at /radar: stop the nav's green pulse now, rather than at the next
 * 90 s tick, and keep any read already under way from restarting it.
 */
export function clearRadarNew(): void {
  radarClearedAt = Date.now();
  if (snapshot.pulse && snapshot.pulse.radarNew > 0) set({ pulse: { ...snapshot.pulse, radarNew: 0 } });
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => EMPTY;

export function useAppPulse(): PulseSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
