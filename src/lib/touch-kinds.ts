/**
 * Which interactions count toward constellation eligibility, and as what. Import-free, so
 * both the SQL aggregates (`constellationSignalAggregates`) and the database triggers that
 * keep `contact_touch_counts` (`src/db/index.ts`) are built from these same lists and cannot
 * drift into disagreeing about who is substantive.
 */

/** Notes, matched on `interaction_type` alone (never on `raw_notes` being present). */
export const NOTE_TOUCH_TYPES = ["note", "meeting_note"] as const;
/** Time spent together. */
export const MEETING_TOUCH_TYPES = ["meeting", "in_person", "call"] as const;
/**
 * Two-way channels: a thread counts when both sides showed up (`messagesQualify`). Gmail sync
 * and the chat importers stamp `direction`; forwarded mail and pre-direction LinkedIn rows
 * land undirected and fall to the volume rule.
 */
export const EXCHANGE_TOUCH_TYPES = ["linkedin_message", "email", "message"] as const;

/**
 * `interactions.source` for rows a model inferred rather than a person logged or a provider
 * recorded (see `interaction-provenance.ts`). They never count as a touch.
 */
export const AI_DERIVED_SOURCE = "ai_derived";

/** A list as a SQL `in (...)` body. The values are the literals above, never user input. */
export function sqlList(values: readonly string[]): string {
  return `(${values.map((v) => `'${v}'`).join(", ")})`;
}
