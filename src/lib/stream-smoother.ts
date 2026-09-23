import { drainCount, safeCut } from "@/lib/stream-drain";

/**
 * Reveals streamed text a frame at a time instead of a network chunk at a time.
 *
 * One smoother lives for one answer: it is created when a question is sent, fed every delta as
 * it arrives, and flushed the moment the answer ends, is stopped, or fails — so the text on
 * screen is always complete when the stream is. The rules for how much to reveal live in
 * `stream-drain.ts`; this only owns the buffer and the frame loop.
 *
 * The scheduler is injectable so the loop can be driven frame by frame in a test, without a
 * browser. In the browser it is `requestAnimationFrame`.
 *
 * Reduced motion is decided when the smoother is made, from the media query itself rather than
 * a hook (whose first render reports "no preference"). It does not slow anything down: it
 * reveals the whole backlog each frame, so text still arrives promptly but without the
 * trickle — one update per frame, never a delay.
 */

export type FrameScheduler = {
  request: (callback: (now: number) => void) => number;
  cancel: (id: number) => void;
};

const browserScheduler: FrameScheduler = {
  request: (cb) => window.requestAnimationFrame(cb),
  cancel: (id) => window.cancelAnimationFrame(id),
};

/**
 * Whether the person has asked for reduced motion, read from the media query at the moment it
 * is needed. Deliberately not the `usePrefersReducedMotion` hook: that reports "no preference"
 * for its first render, and this is called from inside a send handler, long after mount.
 */
export function prefersReducedMotionNow(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type StreamSmoother = {
  /** Add text as it arrives from the network. */
  push: (delta: string) => void;
  /** Reveal everything still waiting, at once. Safe to call repeatedly. */
  flush: () => void;
  /** Stop without revealing the rest — for an unmounted view that has nowhere to draw. */
  cancel: () => void;
};

export function createStreamSmoother(
  apply: (chunk: string) => void,
  options: { reduced?: boolean; scheduler?: FrameScheduler } = {}
): StreamSmoother {
  const scheduler = options.scheduler ?? browserScheduler;
  const reduced = options.reduced ?? false;

  let pending = "";
  let shown = 0;
  let frame: number | null = null;
  let last: number | null = null;
  let done = false;

  const backlog = () => pending.length - shown;

  function tick(now: number) {
    frame = null;
    if (done) return;
    const dt = last === null ? 16 : now - last;
    last = now;

    const want = reduced ? backlog() : drainCount(backlog(), dt);
    const end = safeCut(pending, shown, want);
    const progressed = end > shown;
    if (progressed) {
      const chunk = pending.slice(shown, end);
      shown = end;
      apply(chunk);
    }
    // Trim what has been shown so a long answer does not keep re-scanning its own start.
    if (shown > 4096) {
      pending = pending.slice(shown);
      shown = 0;
    }
    // Nothing revealed with text still waiting means a token is being held back (a marker
    // that has opened but not closed, half a character). More text is what releases it, and
    // `push` schedules the next frame — spinning at 60fps to wait for it would be pure waste.
    if (backlog() > 0 && progressed) schedule();
    else last = null;
  }

  function schedule() {
    if (frame !== null || done) return;
    frame = scheduler.request(tick);
  }

  return {
    push(delta) {
      if (done || !delta) return;
      pending += delta;
      schedule();
    },
    flush() {
      if (done) return;
      done = true;
      if (frame !== null) scheduler.cancel(frame);
      frame = null;
      if (backlog() > 0) {
        const rest = pending.slice(shown);
        pending = "";
        shown = 0;
        apply(rest);
      }
    },
    cancel() {
      done = true;
      if (frame !== null) scheduler.cancel(frame);
      frame = null;
      pending = "";
      shown = 0;
    },
  };
}
