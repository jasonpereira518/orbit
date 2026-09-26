"use client";

import { useSyncExternalStore } from "react";
import {
  INITIAL_CONNECTIVITY,
  initialConnectivity,
  isReconnection,
  nextProbeDelay,
  reduceConnectivity,
  type ConnectivityEvent,
  type ConnectivityState,
} from "@/lib/connectivity";
import { isNetworkError } from "@/lib/errors";

/**
 * The tab's one opinion about whether Orbit is reachable. Everything that talks to the
 * server reports here, and everything that should behave differently offline reads here.
 *
 * Same module-store shape as `app-pulse-store.ts`: module-level state, browser listeners
 * attached by the first subscriber and dropped by the last, read with
 * `useSyncExternalStore` (a module bus read any other way goes stale — see the
 * stale-subscriber note in `app-pulse-store.ts`'s history).
 *
 * The rules for changing state are in `connectivity.ts`; this file is only the wiring:
 * browser `online`/`offline` events, request outcomes reported by callers, and a probe
 * that backs off while Orbit stays unreachable.
 */

/**
 * What the probe asks for: a static file the proxy never touches (`.ico` is on its
 * matcher's static allowlist), so it costs no function invocation, no auth and no
 * database. Any HTTP response at all — even an error page — proves packets reach Orbit.
 */
const PROBE_URL = "/favicon.ico";
const PROBE_TIMEOUT_MS = 6_000;

let state: ConnectivityState = INITIAL_CONNECTIVITY;
let started = false;
let probeTimer: number | null = null;
let probing: Promise<void> | null = null;
const listeners = new Set<() => void>();
const reconnectListeners = new Set<() => void>();

function dispatch(event: ConnectivityEvent) {
  const prev = state;
  const next = reduceConnectivity(prev, event);
  if (next === prev) return;
  state = next;
  for (const l of listeners) l();
  if (isReconnection(prev.status, next.status)) {
    for (const l of reconnectListeners) {
      try {
        l();
      } catch {
        // One bad reconnect handler must not stop the queue flush behind it.
      }
    }
  }
  if (next.status === "online" || next.status === "offline") clearProbe();
  else if (!probing) scheduleProbe();
}

function clearProbe() {
  if (probeTimer !== null) {
    window.clearTimeout(probeTimer);
    probeTimer = null;
  }
}

function scheduleProbe() {
  clearProbe();
  probeTimer = window.setTimeout(() => {
    probeTimer = null;
    void probe();
  }, nextProbeDelay(state.failedProbes));
}

/** Ask Orbit whether it can hear us. Shared while one is in flight. */
function probe(): Promise<void> {
  if (probing) return probing;
  clearProbe();
  probing = (async () => {
    try {
      await fetch(`${PROBE_URL}?probe=${Date.now()}`, {
        method: "HEAD",
        cache: "no-store",
        credentials: "omit",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      probing = null;
      dispatch({ type: "probe_ok" });
    } catch {
      probing = null;
      // Every failure is a new state (`failedProbes` climbs), so `dispatch` schedules the
      // next, longer wait itself.
      dispatch({ type: "probe_failed", at: Date.now() });
    }
  })();
  return probing;
}

function onBrowserOffline() {
  clearProbe();
  dispatch({ type: "browser_offline", at: Date.now() });
}

function onBrowserOnline() {
  dispatch({ type: "browser_online" });
  void probe();
}

function onVisible() {
  // A laptop lid closed on a dead network, reopened on a live one: timers were frozen,
  // so check at once rather than waiting out a 30 s backoff.
  if (document.visibilityState === "visible" && state.status !== "online") void probe();
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  state = initialConnectivity(navigator.onLine !== false, Date.now());
  window.addEventListener("offline", onBrowserOffline);
  window.addEventListener("online", onBrowserOnline);
  document.addEventListener("visibilitychange", onVisible);
}

function stop() {
  if (!started) return;
  started = false;
  clearProbe();
  window.removeEventListener("offline", onBrowserOffline);
  window.removeEventListener("online", onBrowserOnline);
  document.removeEventListener("visibilitychange", onVisible);
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && reconnectListeners.size === 0) stop();
  };
}

const getSnapshot = () => state;
const getServerSnapshot = () => INITIAL_CONNECTIVITY;

export function useConnectivity(): ConnectivityState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** The current status, for code outside React (a poll deciding whether to bother). */
export function getConnectivity(): ConnectivityState {
  if (typeof window !== "undefined") start();
  return state;
}

/**
 * Whether a request right now is pointless. `navigator.onLine` is read directly as well:
 * the store only starts listening once something subscribes, and an action fired before
 * that must still see a device that is plainly offline.
 */
export function isOffline(): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return getConnectivity().status !== "online";
}

/** Run `listener` each time the connection comes back. Returns the unsubscribe. */
export function onReconnect(listener: () => void): () => void {
  start();
  reconnectListeners.add(listener);
  return () => {
    reconnectListeners.delete(listener);
    if (listeners.size === 0 && reconnectListeners.size === 0) stop();
  };
}

/**
 * A request to Orbit came back — with any status. Clears `unreachable` without waiting for
 * the next probe, since real traffic getting through is better evidence than the probe.
 */
export function reportRequestOk() {
  if (state.status !== "online") dispatch({ type: "request_ok" });
}

/**
 * A request to Orbit threw. Only a network failure counts, and even that only starts a
 * probe: one dropped request on a flaky train is not yet "Orbit is unreachable".
 * Returns whether `err` was a network failure, so callers can branch on it in one line.
 */
export function reportRequestError(err: unknown): boolean {
  if (!isNetworkError(err)) return false;
  if (typeof window === "undefined") return true;
  start();
  if (navigator.onLine === false) onBrowserOffline();
  else void probe();
  return true;
}

/** The banner's "Retry now": probe immediately, skipping whatever backoff is left. */
export function retryConnectionNow(): Promise<void> {
  start();
  return probe();
}
