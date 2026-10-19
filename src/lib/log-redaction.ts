import { createHmac } from "node:crypto";
import { KEY_PURPOSES, subKey } from "@/lib/secrets";

/**
 * What a log line carries instead of a client IP: an HMAC of the IP and the UTC day, keyed
 * with the "log-tag" HKDF sub-key of ENCRYPTION_SECRET (audit L-06), cut to 12 hex characters.
 * The same IP reads the same all day, so "one address hammering the form" is still visible;
 * without the key, and after midnight, the tag reverses to nothing. The dev fallback key only
 * ever applies off Vercel without the secret; every deployment refuses to run without it.
 *
 * Nothing stores a tag, so the derivation changed without a legacy fallback: at worst one
 * day's tags read differently either side of the deploy.
 */
export function ipLogTag(ip: string | null | undefined, now: Date = new Date()): string {
  if (!ip) return "none";
  return createHmac("sha256", subKey(KEY_PURPOSES.logTag, "orbit-dev-log-tag"))
    .update(`ip-log:${now.toISOString().slice(0, 10)}:${ip}`)
    .digest("hex")
    .slice(0, 12);
}
