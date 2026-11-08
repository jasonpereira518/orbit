import { createHash } from "node:crypto";

/**
 * The caller's IP from proxy headers.
 *
 * `x-real-ip` first: on Vercel it is the connecting client, set by the platform and not
 * forwardable. The first `x-forwarded-for` hop is the fallback rather than the source —
 * behind any other proxy a client can write that header, and with it choose its own rate-limit
 * bucket. `src/app/api/p/v/route.ts` has the same order for the same reason.
 */
export function clientIpFrom(headers: { get(name: string): string | null }): string {
  return (
    headers.get("x-real-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * A client IP as a rate-limit key. `rate_limit_buckets` names every bucket, and /privacy says
 * the address itself is not kept: salted and hashed, the same IP still lands in the same
 * bucket while the row never holds an address.
 */
export function ipBucketKey(ip: string): string {
  const salt = process.env.ANALYTICS_SALT || process.env.ENCRYPTION_SECRET || "orbit-local";
  return createHash("sha256").update(`ratelimit:${salt}:${ip}`).digest("hex").slice(0, 32);
}
