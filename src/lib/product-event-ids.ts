import { createHash } from "node:crypto";

/**
 * A deterministic event id: the same facts always give the same uuid, so `track()`'s
 * `ON CONFLICT DO NOTHING` makes "once per user" and "once per invite" true even when two
 * requests race or a webhook is retried.
 *
 * A v5-shaped uuid (sha256 truncated, version and variant bits set) so it passes the
 * `z.string().uuid()` the `product_events.id` schema checks. The parts are joined with a
 * separator no id contains; callers pass ids and enums, never free text.
 */
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
