/**
 * "Has the person touched this tab lately?" for background pollers.
 *
 * A visible but forgotten tab (second monitor, a laptop lid left open) is not a person using
 * Orbit, and every poll it makes wakes a serverless function. Pollers skip their tick while
 * `isIdle()` and refresh once from `onResume` when input or the tab coming back ends the idle
 * stretch. Listeners exist only while something is subscribed.
 */

export const IDLE_AFTER_MS = 5 * 60_000;

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"] as const;

let lastInput = Date.now();
const resumers = new Set<() => void>();

export function isIdle(): boolean {
  return Date.now() - lastInput > IDLE_AFTER_MS;
}

/** Counts as activity without notifying: for a caller that already refreshes by itself (the tab becoming visible). */
export function touch(): void {
  lastInput = Date.now();
}

/** Input. Calls the resumers if this ended an idle stretch. */
function markActive(): void {
  const wasIdle = isIdle();
  touch();
  if (wasIdle) for (const fn of [...resumers]) fn();
}

/** `fn` runs when activity ends an idle stretch. Returns the cleanup. */
export function onResume(fn: () => void): () => void {
  if (resumers.size === 0) {
    lastInput = Date.now();
    for (const type of INPUT_EVENTS) window.addEventListener(type, markActive, { passive: true });
  }
  resumers.add(fn);
  return () => {
    resumers.delete(fn);
    if (resumers.size === 0) for (const type of INPUT_EVENTS) window.removeEventListener(type, markActive);
  };
}
