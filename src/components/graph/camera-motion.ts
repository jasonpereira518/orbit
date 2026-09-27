"use client";

import { useSyncExternalStore } from "react";

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
