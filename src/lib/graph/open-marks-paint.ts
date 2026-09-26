import { markOpenStage, openStageMarked } from "@/lib/graph/open-marks";

// Apart from open-marks.ts because only the renderer (a lazy chunk) needs it; the page itself
// ships the smaller half.
/** Mark `first-paint` once the current frame is on screen, then `interactive` at the next idle. */
export function markFirstPaintThenInteractive() {
  if (typeof window === "undefined" || openStageMarked("first-paint")) return;
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
