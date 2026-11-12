/**
 * "A constellation is being drawn", shared between the views menu in the page header and the
 * overlay on the stage.
 *
 * The menu sits above the graph's Suspense boundary and the overlay beside it, and creating a
 * view navigates to `?c=<id>` — which swaps everything under the boundary. A module-scope bus
 * (the same shape as `scope-signal.ts` and `intro-signal.ts`) is the one thing that outlives
 * that swap, so the scene the menu starts is still up when the new sky arrives to end it.
 *
 * Lifecycle: `startGenerating` while the action runs → `awaitNewSky` once it has an id and the
 * route is about to change → ended by the new sky's viewport-ready cue, a safety timeout, or an
 * explicit `stopGenerating` (the failure path). Ending fades for `LEAVE_MS` before clearing.
 */
import { onGraphViewportReady } from "@/lib/graph/intro-signal";

export type GeneratingPhase = "creating" | "arriving" | "leaving";
export type Generating = { prompt: string; phase: GeneratingPhase } | null;

/** The overlay's fade-out; its CSS transition uses the same 300ms. */
export const GENERATING_LEAVE_MS = 300;
/** A new sky that never reports ready (an error under the boundary) must not leave the scene up. */
const ARRIVE_TIMEOUT_MS = 15_000;

let state: Generating = null;
let leaveTimer: ReturnType<typeof setTimeout> | null = null;
let arriveTimer: ReturnType<typeof setTimeout> | null = null;
let releaseReady: (() => void) | null = null;

const listeners = new Set<() => void>();

function set(next: Generating) {
  state = next;
  for (const fn of listeners) fn();
}

function clearTimers() {
  if (leaveTimer !== null) clearTimeout(leaveTimer);
  if (arriveTimer !== null) clearTimeout(arriveTimer);
  leaveTimer = arriveTimer = null;
  releaseReady?.();
  releaseReady = null;
}

export function getGenerating(): Generating {
  return state;
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function startGenerating(prompt: string) {
  clearTimers();
  set({ prompt, phase: "creating" });
}

/**
 * The view exists and the route is about to change. Only from here does a viewport-ready cue
 * end the scene: before it, the sky on screen is the OLD one, and a remount of it (a focus
 * refetch) would otherwise clear the scene while the new view is still being drawn.
 */
export function awaitNewSky() {
  if (!state || state.phase !== "creating") return;
  set({ ...state, phase: "arriving" });
  releaseReady = onGraphViewportReady(stopGenerating);
  arriveTimer = setTimeout(stopGenerating, ARRIVE_TIMEOUT_MS);
}

export function stopGenerating() {
  if (!state || state.phase === "leaving") return;
  clearTimers();
  set({ ...state, phase: "leaving" });
  leaveTimer = setTimeout(() => {
    leaveTimer = null;
    set(null);
  }, GENERATING_LEAVE_MS);
}
