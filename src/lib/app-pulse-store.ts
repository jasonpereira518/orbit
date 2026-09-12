"use client";

import { useSyncExternalStore } from "react";
import { getAppPulse } from "@/actions/app-pulse";
import type { AppPulse } from "@/lib/app-pulse";

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
  set({ loading: true });
  const run = getAppPulse()
    .then((pulse) => {
      if (id === latest) set({ pulse });
    })
    .catch(() => {
      // Network / auth blips: the next tick or the next page load gets it.
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
      if (document.visibilityState === "visible") void refreshPulse();
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
  if (document.visibilityState === "visible") void refreshPulse();
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => EMPTY;

export function useAppPulse(): PulseSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
