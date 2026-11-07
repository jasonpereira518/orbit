"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { SMALL_SKY_QUERY } from "@/components/graph/use-small-sky";
import type { GraphPayload } from "@/components/graph/graph-chart-types";

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
type LayoutModule = typeof import("@/lib/graph/sky-layout");

type Slot<M> = {
  module: M | null;
  promise: Promise<M> | null;
  /** A failed load. Held until `resetConstellationModules()` (the route's retry) clears it. */
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
  layout: {
    module: null,
    promise: null,
    error: null,
    load: () => import("@/lib/graph/sky-layout"),
  } as Slot<LayoutModule>,
};

type SlotName = keyof typeof slots;

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether `err` is the browser failing to fetch a code chunk (a dropped connection, or a tab
 * left open across a deploy so its chunk URLs no longer exist) rather than the chunk itself
 * throwing. Only the former is worth retrying or reloading for.
 */
export function isChunkLoadError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  return (
    typeof message === "string" &&
    /Loading chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
      message
    )
  );
}

/** Pauses between re-attempts of a chunk that failed to download. */
const CHUNK_RETRY_DELAYS_MS = [400, 1500];

async function importWithRetry<M>(slot: Slot<M>): Promise<M> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await slot.load();
    } catch (err) {
      const delay = CHUNK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isChunkLoadError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

const STALE_RELOAD_KEY = "orbit:constellation-chunk-reload";
/** One reload per this window: past it, a still-failing chunk is a real error, not a stale tab. */
const STALE_RELOAD_WINDOW_MS = 60_000;

/**
 * A chunk that will not download even after retries is, most often, a tab that outlived a deploy:
 * the HTML in memory names chunk URLs the server no longer has, and nothing short of a reload
 * fetches the new ones. Reload once, guarded so a chunk that is genuinely broken cannot loop.
 * Skipped offline, where a reload would only trade the error screen for the browser's.
 */
function reloadForStaleChunk(): boolean {
  if (typeof window === "undefined") return false;
  if (navigator.onLine === false) return false;
  try {
    const last = Number(window.sessionStorage.getItem(STALE_RELOAD_KEY));
    if (last && Date.now() - last < STALE_RELOAD_WINDOW_MS) return false;
    window.sessionStorage.setItem(STALE_RELOAD_KEY, String(Date.now()));
  } catch {
    // Storage blocked: with no guard to stop a loop, do not reload.
    return false;
  }
  window.location.reload();
  return true;
}

function load<K extends SlotName>(name: K) {
  const slot = slots[name] as Slot<unknown>;
  if (!slot.promise) {
    slot.promise = importWithRetry(slot).then(
      (m) => {
        slot.module = m;
        for (const l of listeners) l();
        return m;
      },
      (err) => {
        if (isChunkLoadError(err) && reloadForStaleChunk()) {
          // The page is going away; keep the loading panel up rather than flash the error.
          return new Promise<never>(() => {});
        }
        // Surfaced the way `next/dynamic` did: thrown from render, to the error boundary.
        slot.error = err;
        for (const l of listeners) l();
        throw err;
      }
    );
  }
  return slot.promise;
}

/**
 * Forget every failed load so the next render asks for the chunk again. A failure is otherwise
 * sticky for the document, which left the error screen's "Try again" re-throwing the stored error
 * on every attempt: only a full reload could recover. Called by the route's retry.
 */
export function resetConstellationModules() {
  let changed = false;
  for (const slot of Object.values(slots) as Slot<unknown>[]) {
    if (slot.error === null) continue;
    slot.error = null;
    slot.promise = null;
    changed = true;
  }
  if (changed) for (const l of listeners) l();
}

/** Internals for `scripts/smoke-constellation-modules.ts`; nothing in the app reads these. */
export const __testing = { slots, load };

/** Which renderer this viewport draws the sky with — see `use-small-sky.ts`. */
function rendererFor(smallSky: boolean): "flow" | "mobile" {
  return smallSky ? "mobile" : "flow";
}

/**
 * Whether a download nobody has asked for yet is welcome on this connection.
 *
 * The early preload fetches ~200KB of chart code while the payload is still on its way; leave
 * the page before it arrives and that code went unused this visit. It stays in the HTTP cache
 * (`/_next/static` is immutable), so the next visit to the chart gets it free, but on a metered
 * or 2G link the speculation is not worth it: there the code waits for the payload, as it did.
 */
function speculationWelcome() {
  const connection = (
    navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
  ).connection;
  if (!connection) return true;
  if (connection.saveData) return false;
  return !/2g$/.test(connection.effectiveType ?? "");
}

/**
 * Start fetching the chart shell, its layout, and this viewport's renderer. Idempotent, and cheap
 * once done. `speculative` marks a call made before the page knows the chart will be drawn (from
 * `ConstellationIntro`, ahead of the payload); those are skipped where data is precious.
 */
export function preloadConstellation({ speculative = false } = {}) {
  if (typeof window === "undefined") return;
  if (speculative && !speculationWelcome()) return;
  const start = () => {
    void load("shell").catch(() => {});
    void load("layout").catch(() => {});
    void load(rendererFor(window.matchMedia(SMALL_SKY_QUERY).matches)).catch(() => {});
  };
  if (!speculative) return start();
  // Behind whatever the page is doing as it hydrates — above all, fetching and parsing the
  // payload this code is for. Started in the same task, the chunk requests went out first and
  // their evaluation landed in the payload's way, which cost the data 6–13ms at the sizes
  // benchmarked. A background task is still well inside the payload's own round trip.
  const scheduler = (
    globalThis as {
      scheduler?: { postTask?: (cb: () => void, o: { priority: string }) => unknown };
    }
  ).scheduler;
  if (typeof scheduler?.postTask === "function") scheduler.postTask(start, { priority: "background" });
  else window.setTimeout(start, 0);
}

/** The module in `name`'s slot, or null; loaded on demand only while `wanted`. */
export function useSlot<K extends SlotName>(name: K, wanted = true) {
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
 * Whether the opening sky's layout is ready for `payload`, computing it (in slices, see
 * `precomputeSkyLayout`) the moment both the payload and the layout code are here. Hold the chart
 * until it is, and its first render finds the layout waiting instead of computing it inline.
 *
 * A failed or abandoned precompute still reports ready: the chart then lays out in render, as it
 * always did, and any real error surfaces there.
 */
export function useSkyLayoutReady(payload: GraphPayload | null): boolean {
  const layout = useSlot("layout", payload !== null);
  const [settled, setSettled] = useState<GraphPayload | null>(null);
  useEffect(() => {
    if (!layout || !payload) return;
    const abort = new AbortController();
    const settle = () => {
      if (!abort.signal.aborted) setSettled(payload);
    };
    layout.precomputeSkyLayout(payload, abort.signal).then(settle, settle);
    return () => abort.abort();
  }, [layout, payload]);
  if (!payload) return true;
  if (settled === payload) return true;
  return layout?.cachedSkyLayout(payload.contacts, payload.summary.userName) != null;
}
