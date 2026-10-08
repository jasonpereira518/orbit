"use client";

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

/**
 * The camera's zoom, in the two coarse steps the chart's nodes draw from.
 *
 * Every star and cluster name used to ask React Flow's store for the zoom itself, with its own
 * `useStore` selector. React Flow runs every one of those selectors on every camera update, so a
 * 450-star close-up paid ~450 selector runs per wheel event of a pinch just to find, nearly every
 * time, that nothing had changed. Here the chart reads the camera once, rounds it into steps, and
 * only a step change reaches the nodes. Rounding is the nodes' old rounding, unchanged.
 */
export type ZoomChannel = "star" | "name";

const STEP: Record<ZoomChannel, (zoom: number) => number> = {
  // A twentieth of a unit: what a star's relief and label threshold are drawn from.
  star: (zoom) => Math.round(zoom * 20) / 20,
  // Sixteenth-of-an-octave steps: proportional, so a far-out zoom does not jump by a quarter at a time.
  name: (zoom) => Math.pow(2, Math.round(Math.log2(Math.max(zoom, 0.01)) * 16) / 16),
};

const CHANNELS = Object.keys(STEP) as ZoomChannel[];

export function createZoomSteps(initialZoom: number) {
  const value = { star: STEP.star(initialZoom), name: STEP.name(initialZoom) };
  const listeners = { star: new Set<() => void>(), name: new Set<() => void>() };
  return {
    get: (channel: ZoomChannel) => value[channel],
    /** Called with every camera update; notifies a channel only when its step moved. */
    set(zoom: number) {
      for (const channel of CHANNELS) {
        const next = STEP[channel](zoom);
        if (next === value[channel]) continue;
        value[channel] = next;
        for (const listener of listeners[channel]) listener();
      }
    },
    subscribe(channel: ZoomChannel, listener: () => void) {
      listeners[channel].add(listener);
      return () => {
        listeners[channel].delete(listener);
      };
    },
  };
}

export type ZoomSteps = ReturnType<typeof createZoomSteps>;

const ZoomStepsContext = createContext<ZoomSteps | null>(null);
export const ZoomStepsProvider = ZoomStepsContext.Provider;

/**
 * What a node draws from the current zoom step. `select` maps the step to the value the node
 * actually renders from (a star's relief, say), and the node re-renders only when that value
 * changes — a star at a zoom where its relief has stopped varying ignores the step entirely.
 * Outside a chart there is no camera, and the answer is the step for zoom 1.
 */
export function useZoomStep<T>(channel: ZoomChannel, select: (step: number) => T): T {
  const steps = useContext(ZoomStepsContext);
  const subscribe = useCallback(
    (listener: () => void) => (steps ? steps.subscribe(channel, listener) : () => {}),
    [steps, channel]
  );
  const snapshot = () => select(steps ? steps.get(channel) : STEP[channel](1));
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
