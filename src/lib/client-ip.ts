import { createHash, createHmac } from "node:crypto";
import { KEY_PURPOSES, deriveKey, encryptionSecret } from "@/lib/secrets";

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

/** What the rate-limit salt is derived from: the analytics salt if set, else the app secret. */
function saltSource(): string {
  return process.env.ANALYTICS_SALT || encryptionSecret("orbit-local");
}

/**
 * A client IP as a rate-limit key. `rate_limit_buckets` names every bucket, and /privacy says
 * the address itself is not kept: keyed and hashed, the same IP still lands in the same
 * bucket while the row never holds an address.
 *
 * Keyed with the "rate-limit-salt" HKDF sub-key (audit L-06) rather than the raw secret,
 * which also signs and encrypts. Buckets written under the old derivation are still counted
 * by `consumeIpBucket` until they age out (`legacyIpBucketKey`).
 */
export function ipBucketKey(ip: string): string {
  return createHmac("sha256", deriveKey(saltSource(), KEY_PURPOSES.rateLimitSalt))
    .update(`ratelimit:${ip}`)
    .digest("hex")
    .slice(0, 32);
}

/** The pre-HKDF key: a plain digest of the raw salt and the IP. Read-only from here on. */
export function legacyIpBucketKey(ip: string): string {
  return createHash("sha256").update(`ratelimit:${saltSource()}:${ip}`).digest("hex").slice(0, 32);
}
