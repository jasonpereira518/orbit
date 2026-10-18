import { createHash } from "node:crypto";

/**
 * A deterministic event id: the same facts always hash to the same uuid, so a retry, a
 * double-invoked server action or a replayed offline queue lands on `product_events`'s
 * primary key and `ON CONFLICT DO NOTHING` drops it.
 *
 *   track("followup_completed", props, { id: eventId("followup_completed", reminderId, completedAt.toISOString()) })
 *
 * Shape is a version-5-style uuid (SHA-1 over a fixed namespace plus the parts), the form
 * `product_events.id` and every uuid-typed property already accept. Parts are joined with a
 * separator that cannot appear in an id or an ISO timestamp, so ("a","bc") and ("ab","c")
 * differ.
 *
 * Hash only ids, enums and timestamps. The input never leaves the process, but a hash of
 * free text is still a fingerprint of it.
 */
const NAMESPACE = "orbit.product-events.v1";

export function eventId(...parts: Array<string | number>): string {
  const h = createHash("sha1").update(NAMESPACE).update("\u0000").update(parts.join("\u0000")).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
