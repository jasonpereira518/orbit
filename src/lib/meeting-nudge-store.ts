/**
 * The calendar nudge's client state: this device's on/off, which offers were dismissed, and
 * the shared poll that keeps the upcoming list fresh. The same shape as `app-pulse-store.ts` —
 * module state, `subscribe`, `useSyncExternalStore` — and for the same reason: one poll per
 * tab however many components read it.
 *
 * Cheap by construction. The network is touched once every ten minutes at most (and not at
 * all for someone with no calendar connected or no meetings plan: the first non-`ok` answer
 * stops it for the session); the 15-second tick only compares clocks locally.
 *
 * It is deliberately NOT paused while the tab is hidden. The case it exists for is Orbit
 * sitting in a background tab while the call is in another one. A hidden tab's timers slow to
 * about one a minute, which still lands inside the two-minutes-before window, and that is
 * when the desktop alert — not the in-app card, which nobody is looking at — does the work.
 */

import { useSyncExternalStore } from "react";
import { getMeetingCandidates } from "@/actions/meetings";
import { showDesktopNotification } from "@/lib/browser-notifications";
import type { MeetingCandidate } from "@/lib/meeting-calendar";
import { nudgeKey, nudgeTiming, pickNudge } from "@/lib/meeting-nudge";

const PREF_KEY = "orbit:meeting-nudge:v1";
const DISMISSED_KEY = "orbit:meeting-nudge-dismissed:v1";
const MAX_DISMISSED = 50;

const REFRESH_MS = 10 * 60_000;
const TICK_MS = 15_000;
/** Don't hit the server on every tab focus; the list is good for a few minutes. */
const FOCUS_REFRESH_MS = 5 * 60_000;
/** Let the page finish loading before the first calendar read. */
const FIRST_REFRESH_DELAY_MS = 3_000;

// ── This device's on/off ──────────────────────────────────────────────────────────────

/** On unless this device turned it off. Per-device, like the sound and the mute in `ding.ts`. */
export function isMeetingNudgeOn(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

const prefListeners = new Set<() => void>();

export function setMeetingNudgeOn(on: boolean): void {
  try {
    if (on) localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, "0");
  } catch {
    // Storage blocked: the choice just won't outlive the tab.
  }
  prefListeners.forEach((l) => l());
  recompute();
}

function subscribePref(listener: () => void) {
  prefListeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === PREF_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    prefListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Reactive read of the setting; `false` on the server so hydration agrees. */
export function useMeetingNudgeOn(): boolean {
  return useSyncExternalStore(subscribePref, isMeetingNudgeOn, () => false);
}

/**
 * The same, for showing it to the user: `null` until the browser has read the real value.
 * The default is ON, so the server's `false` above would flash "Off" at everyone first.
 */
export function useMeetingNudgeSetting(): boolean | null {
  return useSyncExternalStore<boolean | null>(subscribePref, isMeetingNudgeOn, () => null);
}

// ── Dismissals ────────────────────────────────────────────────────────────────────────

/** Covers the blocked-storage case within a tab's life. */
const dismissedInSession = new Set<string>();

function readDismissed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/** "Not now" for this one occurrence. */
export function dismissMeetingNudge(key: string): void {
  const next = [...readDismissed(), key].slice(-MAX_DISMISSED);
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: it comes back after a reload, which is acceptable for a nudge.
  }
  dismissedInSession.add(key);
  recompute();
}

// ── The shared poll ───────────────────────────────────────────────────────────────────

export type NudgeSnapshot = { nudge: MeetingCandidate | null; timing: string };
const EMPTY: NudgeSnapshot = { nudge: null, timing: "" };

let snapshot: NudgeSnapshot = EMPTY;
let events: MeetingCandidate[] = [];
/** Not connected, no plan, or the read failed: stop asking for the rest of this session. */
let stopped = false;
let lastRefresh = 0;
const listeners = new Set<() => void>();
let timers: {
  first?: ReturnType<typeof setTimeout>;
  refresh?: ReturnType<typeof setInterval>;
  tick?: ReturnType<typeof setInterval>;
} = {};

async function refresh(): Promise<void> {
  if (stopped || !isMeetingNudgeOn()) return;
  lastRefresh = Date.now();
  try {
    const res = await getMeetingCandidates();
    if (!res.ok || res.status !== "ok") {
      stopped = true;
      events = [];
    } else {
      events = res.events;
    }
  } catch {
    // Offline or a transient failure: keep what we have and try again next time.
  }
  recompute();
}

function recompute(): void {
  const now = Date.now();
  const dismissed = new Set([...readDismissed(), ...dismissedInSession]);
  const nudge = isMeetingNudgeOn() ? pickNudge(events, now, dismissed) : null;
  const timing = nudge ? nudgeTiming(nudge, now) : "";

  const sameOffer = (nudge ? nudgeKey(nudge) : null) === (snapshot.nudge ? nudgeKey(snapshot.nudge) : null);
  if (sameOffer && timing === snapshot.timing) return;

  snapshot = nudge ? { nudge, timing } : EMPTY;
  if (nudge && !sameOffer) alertDesktop(nudge);
  listeners.forEach((l) => l());
}

/**
 * An OS notification, only when nobody is looking at the in-app card: a visible tab already
 * has it. `showDesktopNotification` applies the user's own opt-in and dedupes by id, so a
 * recurring recompute never alerts twice. There is no Web Push — this fires only while an
 * Orbit tab exists.
 */
function alertDesktop(c: MeetingCandidate): void {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return;
  void showDesktopNotification({
    id: `meeting-nudge:${nudgeKey(c)}`,
    title: c.title,
    body: `${nudgeTiming(c, Date.now())} — open Orbit to record it`,
    url: "/capture?mode=meeting",
  }).catch(() => {});
}

function onVisibility(): void {
  if (document.visibilityState === "visible" && Date.now() - lastRefresh > FOCUS_REFRESH_MS) void refresh();
  else recompute();
}

function start(): void {
  timers.first = setTimeout(() => void refresh(), FIRST_REFRESH_DELAY_MS);
  timers.refresh = setInterval(() => void refresh(), REFRESH_MS);
  timers.tick = setInterval(recompute, TICK_MS);
  document.addEventListener("visibilitychange", onVisibility);
}

function stop(): void {
  clearTimeout(timers.first);
  clearInterval(timers.refresh);
  clearInterval(timers.tick);
  timers = {};
  document.removeEventListener("visibilitychange", onVisibility);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

const subscribeNothing = () => () => {};

/**
 * The offer to show right now, and how to word its timing. `enabled` false (an account
 * without meeting recording) does not subscribe, so the poll never starts for it.
 */
export function useMeetingNudgeSnapshot(enabled: boolean): NudgeSnapshot {
  return useSyncExternalStore(enabled ? subscribe : subscribeNothing, () => (enabled ? snapshot : EMPTY), () => EMPTY);
}
