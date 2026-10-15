import { createHash } from "node:crypto";

/**
 * The caller's IP from proxy headers: the first `x-forwarded-for` hop (the client; the rest
 * are proxies), then `x-real-ip`, else "unknown". Usable by any server action or core with
 * Next's `headers()` or a plain test object.
 */
export function clientIpFrom(headers: { get(name: string): string | null }): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
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
