import { clientIpFrom, ipBucketKey } from "@/lib/client-ip";
import { RATE_LIMITS, bucketCount, consumeIpBucket, isRateLimitedError, softenedLimit } from "@/lib/rate-limit";

/**
 * Per-IP throttle for the one-click unsubscribe POSTs (waitlist, Radar digest, credit emails).
 *
 * It counts MISSES, not requests. Gmail's and Yahoo's unsubscribe buttons (RFC 8058) POST from
 * the provider's servers, so one address can carry many real people, and refusing a valid
 * unsubscribe is the one failure these routes must not have. A caller that has sent
 * `unsubscribeMiss.limit` bad tokens within the window is refused before its next token is
 * even checked, so guessing gets no answer; anyone else is never slowed down.
 *
 * Usage, in a POST handler:
 *   if (await unsubscribeAttemptsExhausted(request)) return <429 page>;
 *   const ok = await <the token check and write>;
 *   if (!ok) await recordUnsubscribeMiss(request);
 */
const SCOPE = "unsubscribeMiss";

/** True when this caller's IP has used up its bad-token allowance for the window. */
export async function unsubscribeAttemptsExhausted(request: { headers: Headers }): Promise<boolean> {
  const key = ipBucketKey(clientIpFrom(request.headers));
  const policy = RATE_LIMITS.unsubscribeMiss;
  const misses = await bucketCount(SCOPE, key, policy);
  if (misses < policy.limit) return false;
  // Under `ORBIT_NEW_LIMITS=log` this is logged and let through, like the other new limits.
  return !softenedLimit(SCOPE, key, `misses=${misses} limit=${policy.limit}`);
}

/** Count one bad token against the caller's IP. Never throws: the 404 still goes out. */
export async function recordUnsubscribeMiss(request: { headers: Headers }): Promise<void> {
  try {
    await consumeIpBucket(SCOPE, clientIpFrom(request.headers), RATE_LIMITS.unsubscribeMiss);
  } catch (err) {
    // Over the limit is the expected way to fill the bucket; anything else is the limiter.
    if (!isRateLimitedError(err)) console.error("[unsubscribe] miss counter failed", err);
  }
}
