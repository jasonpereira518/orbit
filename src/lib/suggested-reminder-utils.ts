import { sha256Hex } from "@/lib/crypto";

/**
 * Provenance marker on `reminders.reminderType` for rows that came from a date the
 * user wrote in a note. Plain text — `reminderType` is not a PG enum.
 */
export const EXTRACTED_DATE_REMINDER_TYPE = "extracted_date";

/**
 * Re-exported from `@/lib/dates`, which is the canonical home now that client
 * components need these too — this module imports `node:crypto` and so cannot be
 * bundled for the browser. Existing importers keep working unchanged.
 */
export { isoDay, isoDayToLocalNoon } from "@/lib/dates";

/** Aggressive normalization so trivial whitespace edits don't defeat re-parse dedupe. */
export function hashSourceNote(text: string) {
  return sha256Hex(text.replace(/\s+/g, " ").trim().toLowerCase());
}

/** The per-item dedupe key backing the unique (userId, itemHash) index. */
export function buildSuggestionItemHash(
  sourceHash: string,
  dueDateIso: string,
  title: string
) {
  return sha256Hex(`${sourceHash}|${dueDateIso}|${title.trim().toLowerCase()}`);
}
