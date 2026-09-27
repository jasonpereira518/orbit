import { createHmac } from "node:crypto";

/**
 * What a log line carries instead of a client IP: an HMAC of the IP and the UTC day, keyed
 * with ENCRYPTION_SECRET, cut to 12 hex characters. The same IP reads the same all day, so
 * "one address hammering the form" is still visible; without the key, and after midnight,
 * the tag reverses to nothing. The dev fallback key only ever applies without the secret,
 * which production refuses to start without (src/lib/env.ts).
 */
export function ipLogTag(ip: string | null | undefined, now: Date = new Date()): string {
  if (!ip) return "none";
  const key = process.env.ENCRYPTION_SECRET || "orbit-dev-log-tag";
  return createHmac("sha256", key)
    .update(`ip-log:${now.toISOString().slice(0, 10)}:${ip}`)
    .digest("hex")
    .slice(0, 12);
}
