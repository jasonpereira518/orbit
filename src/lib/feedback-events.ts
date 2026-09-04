"use client";

import { useSyncExternalStore } from "react";

/**
 * The one mounted feedback widget, and everyone who talks to it.
 *
 * There are four doors — the desktop rail button, the mobile header button, the mobile
 * "More" sheet and Settings → Help — but only ONE `FeedbackWidget`, because it owns a
 * single draft (message, screenshots, drag offset) that all four must share. That is the
 * difference from the notifications bell, which is simply mounted twice and lets each
 * copy own its own panel.
 *
 * A store rather than the `window` event this used to be (cf. `src/lib/ask-bar-events.ts`,
 * which is still an event because the ask bar needs none of the below):
 *
 *  - The triggers have to READ the panel's state, to duck out of the way while it is open
 *    the way the bell does. An event only travels one way.
 *  - `FeedbackWidgetLazy` is `dynamic(..., { ssr: false })`, so a press in the frames
 *    before its chunk lands would dispatch into nothing and be silently lost. A pending
 *    request just waits until the widget subscribes.
 */

/**
 * What the triggers need to know.
 *
 * `capturing` covers the widget's `capturing` AND `selecting` phases, and means the
 * triggers must be absent from the tree rather than merely transparent: `getDisplayMedia`
 * photographs the composited output, so a faded button is still in the picture.
 */
export type FeedbackPanelState = "closed" | "open" | "capturing";

let panelState: FeedbackPanelState = "closed";
let pendingOrigin: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/**
 * Ask the widget to open, telling it what to grow out of.
 *
 * `origin` is a CSS `transform-origin` in the panel's own coordinate space — see
 * `originFromTrigger` in `src/lib/floating-panel.ts`. Doors with no trigger on screen pass
 * `PANEL_ORIGIN_FALLBACK`.
 */
export function requestFeedbackOpen(origin: string) {
  pendingOrigin = origin;
  emit();
}

/**
 * Widget only. Reads and clears in one go, so a request is acted on exactly once however
 * many times the subscriber re-runs.
 */
export function takeFeedbackOpenRequest(): string | null {
  const next = pendingOrigin;
  pendingOrigin = null;
  return next;
}

/** Widget only. Publishes what the triggers render against. */
export function setFeedbackPanelState(next: FeedbackPanelState) {
  if (panelState === next) return;
  panelState = next;
  emit();
}

/**
 * Trigger side. The server snapshot is `"closed"`, so a trigger renders visible on the
 * server and stays visible through hydration.
 */
export function useFeedbackPanelState(): FeedbackPanelState {
  return useSyncExternalStore(
    subscribe,
    () => panelState,
    () => "closed" as const
  );
}

/** Widget only. Notified when a door asks to open; read the request with `take…`. */
export function subscribeFeedbackOpen(callback: () => void) {
  return subscribe(callback);
}
