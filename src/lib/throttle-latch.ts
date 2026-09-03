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

export function shouldRecordThrottled(key: string, windowMs = 60 * 60 * 1000): boolean {
  const now = Date.now();
  const last = latches.get(key);
  if (last && now - last < windowMs) return false;
  latches.set(key, now);
  return true;
}
