"use client";

import { useSyncExternalStore } from "react";
import { prefersReducedMotion } from "@/lib/motion-preference";

/**
 * Is the sky's camera moving right now?
 *
 * The chart sets this from React Flow's `onMoveStart` / `onMoveEnd`, and parts of the sky that
 * are expensive to redraw read it to hold still until the camera stops. It lives outside React
 * state on purpose: a pan or a zoom must not re-render the chart to say that it is happening,
 * and the one component that does re-render (the dust canvas) subscribes to it alone.
 */
let moving = false;
const listeners = new Set<() => void>();

export function setCameraMoving(next: boolean) {
  if (moving === next) return;
  moving = next;
  for (const listener of listeners) listener();
}

export function isCameraMoving() {
  return moving;
}

export function subscribeCameraMoving(listener: () => void) {
  return subscribe(listener);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot() {
  return moving;
}

/** Server render: nothing is moving before hydration, and the first paint must match. */
function serverSnapshot() {
  return false;
}

export function useCameraMoving() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/**
 * How far the starfield trails the camera, in screen px.
 *
 * The stars are far behind the chart, so a pan moves them a small fraction of what it moves
 * the chart: that gap is the depth. `tanh` keeps the drift under `SKY_DRIFT_MAX_PX` however
 * far you travel (the starfield carries exactly that much spare margin), and is linear for
 * small pans. Measured as how far the sun — world origin — sits from the stage centre, which
 * is zero at the default framing at any zoom, so the opening view and the warp hand-off land
 * on the same sky as before.
 */
export const SKY_DRIFT_MAX_PX = 28;
const SKY_DRIFT_RATIO = 0.05;

let drift = { x: 0, y: 0 };
const driftListeners = new Set<(x: number, y: number) => void>();

const driftOf = (pan: number) =>
  SKY_DRIFT_MAX_PX * Math.tanh((pan * SKY_DRIFT_RATIO) / SKY_DRIFT_MAX_PX);

/** `panX`/`panY`: the sun's screen position minus the stage centre. Held still under reduced motion. */
export function setSkyDrift(panX: number, panY: number) {
  const still = prefersReducedMotion();
  drift = { x: still ? 0 : driftOf(panX), y: still ? 0 : driftOf(panY) };
  for (const listener of driftListeners) listener(drift.x, drift.y);
}

/** Calls back at once with the current drift, then on every change. */
export function subscribeSkyDrift(listener: (x: number, y: number) => void) {
  driftListeners.add(listener);
  listener(drift.x, drift.y);
  return () => {
    driftListeners.delete(listener);
  };
}
