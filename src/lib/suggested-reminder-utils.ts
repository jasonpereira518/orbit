import { createHash } from "node:crypto";

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

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Aggressive normalization so trivial whitespace edits don't defeat re-parse dedupe. */
export function hashSourceNote(text: string) {
  return sha256(text.replace(/\s+/g, " ").trim().toLowerCase());
}

/** The per-item dedupe key backing the unique (userId, itemHash) index. */
export function buildSuggestionItemHash(
  sourceHash: string,
  dueDateIso: string,
  title: string
) {
  return sha256(`${sourceHash}|${dueDateIso}|${title.trim().toLowerCase()}`);
}
