/**
 * In-memory sliding-window rate limiter.
 *
 * State lives in a `Map` in this process's memory: it resets on redeploy/restart and is
 * never shared across serverless instances or replicas. That makes it per-instance and
 * therefore soft — good enough to blunt accidental retry storms or a single abusive
 * client, but not an authoritative global limit. Do not rely on it to hard-cap anything
 * that must be enforced across the whole fleet.
 */
const buckets = new Map<string, number[]>();

/**
 * Attempts to take one token from `key`'s bucket under a sliding window of `windowMs`
 * milliseconds allowing at most `max` tokens. Returns whether the call is allowed.
 */
export function takeToken(
  key: string,
  opts: { max: number; windowMs: number },
): boolean {
  const now = Date.now();
  const windowStart = now - opts.windowMs;
  const timestamps = (buckets.get(key) ?? []).filter((t) => t > windowStart);

  if (timestamps.length >= opts.max) {
    buckets.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  buckets.set(key, timestamps);
  return true;
}
