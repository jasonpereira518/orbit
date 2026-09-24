"use client";

import { useEffect, useSyncExternalStore } from "react";
import { SMALL_SKY_QUERY } from "@/components/graph/use-small-sky";

/**
 * The constellation's lazily-loaded code — the chart shell and its two renderers — loaded ahead
 * of time and rendered without a Suspense boundary.
 *
 * Both halves are what `next/dynamic` did not do, and each cost the open a measured wait:
 *
 * - **Ahead of time.** `next/dynamic` requests a chunk when its component first renders, which
 *   for the chart is after the payload has arrived, and the renderer's chunk only after the
 *   shell's had evaluated: two round trips in series after the data, instead of alongside it.
 *   `preloadConstellation()` starts all of it at once, from the part of the page that hydrates
 *   before the payload does (`ConstellationIntro`).
 * - **No Suspense.** A `React.lazy` component suspends on its first render even when its chunk
 *   is already in memory, and once a boundary has shown its fallback React holds the content
 *   back until 300ms after that (its fallback throttle). On /graph that floor, not the network,
 *   was when the sky appeared. Here a component is rendered only once its module is loaded, so
 *   the loading panel is ordinary output rather than a fallback, and nothing is throttled.
 *
 * Read through `useSyncExternalStore` with a null server snapshot, so the server and hydration
 * both render the loading state and the client moves on the moment the module lands.
 */

type NetworkGraphModule = typeof import("@/components/graph/network-graph");
type FlowModule = typeof import("@/components/graph/graph-canvas-flow");
type MobileModule = typeof import("@/components/graph/graph-canvas-mobile");

type Slot<M> = {
  module: M | null;
  promise: Promise<M> | null;
  /** A failed load. Sticky for the document, as a rejected `React.lazy` is. */
  error: unknown;
  load: () => Promise<M>;
};

const slots = {
  shell: {
    module: null,
    promise: null,
    error: null,
    load: () => import("@/components/graph/network-graph"),
  } as Slot<NetworkGraphModule>,
  flow: {
    module: null,
    promise: null,
    error: null,
    load: () => import("@/components/graph/graph-canvas-flow"),
  } as Slot<FlowModule>,
  mobile: {
    module: null,
    promise: null,
    error: null,
    load: () => import("@/components/graph/graph-canvas-mobile"),
  } as Slot<MobileModule>,
};

type SlotName = keyof typeof slots;

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function load<K extends SlotName>(name: K) {
  const slot = slots[name] as Slot<unknown>;
  if (!slot.promise) {
    slot.promise = slot.load().then(
      (m) => {
        slot.module = m;
        for (const l of listeners) l();
        return m;
      },
      (err) => {
        // Surfaced the way `next/dynamic` did: thrown from render, to the error boundary.
        slot.error = err;
        for (const l of listeners) l();
        throw err;
      }
    );
  }
  return slot.promise;
}

/** Which renderer this viewport draws the sky with — see `use-small-sky.ts`. */
function rendererFor(smallSky: boolean): "flow" | "mobile" {
  return smallSky ? "mobile" : "flow";
}

/**
 * Start fetching the chart shell and this viewport's renderer. Idempotent, and cheap once done.
 * Call it as early as the page knows the chart is coming.
 */
export function preloadConstellation() {
  if (typeof window === "undefined") return;
  void load("shell").catch(() => {});
  void load(rendererFor(window.matchMedia(SMALL_SKY_QUERY).matches)).catch(() => {});
}

/** The module in `name`'s slot, or null; loaded on demand only while `wanted`. */
function useSlot<K extends SlotName>(name: K, wanted = true) {
  const mod = useSyncExternalStore(
    subscribe,
    () => slots[name].module as (typeof slots)[K]["module"],
    () => null
  );
  const failed = useSyncExternalStore(
    subscribe,
    () => slots[name].error,
    () => null
  );
  useEffect(() => {
    if (wanted && !mod && !failed) void load(name).catch(() => {});
  }, [mod, failed, name, wanted]);
  if (wanted && failed) throw failed;
  return mod;
}

/** The chart shell (`NetworkGraph`), or null until its chunk has loaded. */
export function useNetworkGraphModule() {
  return useSlot("shell");
}

/**
 * The renderer for this viewport, as `{ Chart }` (render `<renderer.Chart />`), or null until
 * its chunk has loaded. `Chart` is a module export, so its identity is stable across renders.
 */
export function useSkyRenderer(smallSky: boolean) {
  // Both hooks run so their order is fixed, but only the chosen renderer is ever requested: a
  // phone must not download React Flow, nor a laptop the canvas renderer.
  const flow = useSlot("flow", !smallSky);
  const mobile = useSlot("mobile", smallSky);
  if (smallSky) return mobile ? { Chart: mobile.GraphCanvasMobile } : null;
  return flow ? { Chart: flow.GraphCanvasFlow } : null;
}
