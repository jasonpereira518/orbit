/**
 * A once-per-window latch for call sites that can fire on every request.
 *
 * Module-scope state, so it is per-lambda-instance — the same shape as
 * `microlinkCooldownUntil` in `contact-avatar.ts`. Deliberately not a general throttling
 * framework; it exists so one broken subsystem cannot write a row (or a Slack message)
 * per request.
 *
 * Its own module, with no imports at all, because `src/instrumentation.ts` reaches it from
 * the Edge runtime bundle — anything that pulled `@/db` in here would drag PGlite into that
 * bundle and trip the "Node.js API in the Edge Runtime" warning at build.
 */
const latches = new Map<string, number>();

/**
 * Past this many keys, expired ones are swept. Some keys carry request data (the CSP
 * report's `blockedUri`), so without a bound the map grows for the life of the instance.
 * The threshold then rises to twice what survived, so a flood of live keys costs amortized
 * O(1) per call rather than a full scan on every one.
 */
const SWEEP_ABOVE = 1000;
let sweepAbove = SWEEP_ABOVE;

/**
 * The widest window any call has used. An entry at least this old answers "record" to any
 * call that could plausibly ask about it again, exactly as a missing entry does — so
 * sweeping it changes no return value. (Every call site uses one window per key.)
 */
let widestWindowMs = 0;

export function shouldRecordThrottled(key: string, windowMs = 60 * 60 * 1000): boolean {
  const now = Date.now();
  if (windowMs > widestWindowMs) widestWindowMs = windowMs;
  const last = latches.get(key);
  if (last && now - last < windowMs) return false;
  latches.set(key, now);
  if (latches.size > sweepAbove) {
    for (const [k, at] of latches) {
      if (now - at >= widestWindowMs) latches.delete(k);
    }
    sweepAbove = Math.max(SWEEP_ABOVE, latches.size * 2);
  }
  return true;
}
