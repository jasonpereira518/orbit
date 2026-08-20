import { createHash } from "node:crypto";

/**
 * Provenance marker on `reminders.reminderType` for rows that came from a date the
 * user wrote in a note. Plain text — `reminderType` is not a PG enum.
 */
export const EXTRACTED_DATE_REMINDER_TYPE = "extracted_date";

export function isoDay(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Parses YYYY-MM-DD at local noon. Never `new Date(iso)`, which parses as UTC and can
 * land on the previous calendar day for western timezones.
 */
export function isoDayToLocalNoon(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0, 0);
}

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
