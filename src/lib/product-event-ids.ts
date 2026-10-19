import { createHash } from "node:crypto";

/**
 * Deterministic event ids: the same facts always hash to the same uuid, so a retry, a
 * double-invoked server action, a racing request or a retried webhook lands on
 * `product_events`'s primary key and `ON CONFLICT DO NOTHING` drops it. That is what makes
 * "once per user" and "once per invite" true.
 *
 *   track("followup_completed", props, { id: eventId("followup_completed", reminderId, completedAt.toISOString()) })
 *
 * Two functions, one idea. They hash differently (SHA-1 over a namespace, and SHA-256) and
 * must NOT be swapped for each other: an id written by one would not match the same facts
 * hashed by the other, and the dedupe would silently stop working for rows already written.
 * Pick the one the surrounding code already uses.
 *
 * Hash only ids, enums and timestamps. The input never leaves the process, but a hash of free
 * text is still a fingerprint of it.
 */
const NAMESPACE = "orbit.product-events.v1";

/** Version-5-style uuid over a fixed namespace plus the parts, joined by a NUL no id contains. */
export function eventId(...parts: Array<string | number>): string {
  const h = createHash("sha1").update(NAMESPACE).update("\u0000").update(parts.join("\u0000")).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A v5-shaped uuid (SHA-256 truncated, version and variant bits set) that passes `z.string().uuid()`. */
export function deterministicEventId(...parts: Array<string | number>): string {
  const hex = createHash("sha256").update(parts.join("␟"), "utf8").digest("hex");
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
