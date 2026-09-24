/**
 * `performance.mark()`s for the stages of opening the constellation.
 *
 *   data-fetch-start → data-received → renderer-loaded → layout-computed → first-paint → interactive
 *
 * They exist so "opening the chart is slow" can be split into WHICH stage is slow, in the
 * DevTools Performance panel's Timings track or from a script
 * (`scripts/bench/constellation-interactions.mjs` reads them). Nothing in the product reads them.
 *
 * Each stage marks once per open: a filter change recomputes the layout, but it is not the open.
 * An open starts at `data-fetch-start` or, where the fetch happened on the server and the client
 * never saw it start (the real /graph page), at `data-received`.
 *
 * - `renderer-loaded`: the renderer's chunk has evaluated and it is rendering for the first time.
 * - `first-paint`: the frame the chart stops being hidden (the stage stays at opacity 0 until the
 *   camera has its real framing) has been painted.
 * - `interactive`: the first idle period after that — the main thread has nothing queued, so a
 *   pointer or wheel event would be handled on arrival.
 */
export type OpenStage =
  | "data-fetch-start"
  | "data-received"
  | "renderer-loaded"
  | "layout-computed"
  | "first-paint"
  | "interactive";

export const OPEN_MARK_PREFIX = "constellation:";

const done = new Set<OpenStage>();

export function markOpenStage(stage: OpenStage) {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  if (stage === "data-fetch-start" || (stage === "data-received" && !done.has("data-fetch-start"))) {
    done.clear();
  }
  if (done.has(stage)) return;
  done.add(stage);
  performance.mark(OPEN_MARK_PREFIX + stage);
}

/** Mark `first-paint` once the current frame is on screen, then `interactive` at the next idle. */
export function markFirstPaintThenInteractive() {
  if (typeof window === "undefined" || done.has("first-paint")) return;
  requestAnimationFrame(() => {
    // rAF callbacks run before the frame paints; a task queued from one runs after it.
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      markOpenStage("first-paint");
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => markOpenStage("interactive"));
      } else {
        setTimeout(() => markOpenStage("interactive"), 0);
      }
    };
    channel.port2.postMessage(null);
  });
}
