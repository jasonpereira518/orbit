/**
 * Pure helpers shared by the save path (src/lib/note-batch-save.ts), the capture action, and
 * the results page. No DB, no AI — everything here is unit-checkable.
 */
import { atLocalNoon } from "@/lib/interaction-date";
import type { NoteBatchResult, ReminderDateBasis } from "@/db/schema";
import type { MentionMatchedBy } from "@/lib/mention-resolution";

export type { NoteBatchResult, ReminderDateBasis };

/** One mention surfaced by `parseBulkCaptureNotes`, echoed through the panel's done step. */
export type PreviewMention = { text: string; context: string | null; nearPerson: string | null; contactId: string | null; confidence: number; matchedBy: MentionMatchedBy | null };

export const DEFAULT_FOLLOW_UP_WINDOW_DAYS = 14;
export const COLLISION_WINDOW_DAYS = 3;
export const NOTE_INTERACTION_EXTERNAL_ID_PREFIX = "notes:";

/** Re-pasting the same note for the same contact must not log a second interaction. */
export function noteInteractionExternalId(sourceHash: string, contactId: string) {
  return `${NOTE_INTERACTION_EXTERNAL_ID_PREFIX}${sourceHash}:${contactId}`;
}

export function windowDueDate(anchor: Date, days = DEFAULT_FOLLOW_UP_WINDOW_DAYS) {
  const d = new Date(anchor);
  d.setDate(d.getDate() + days);
  return atLocalNoon(d);
}

export function emptyNoteBatchResult(): NoteBatchResult {
  return {
    participants: [],
    mentions: [],
    unresolvedMentions: [],
    actionItems: [],
    reminders: [],
    skipped: { relative: 0, unverifiable: 0, past: 0, duplicate: 0 },
  };
}

export function normalizeTitle(s: string) {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function titlesCollide(a: string, b: string) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  return Boolean(na) && Boolean(nb) && (na === nb || na.includes(nb) || nb.includes(na));
}

export function withinCollisionWindow(a: Date, b: Date, days = COLLISION_WINDOW_DAYS) {
  return Math.abs(a.getTime() - b.getTime()) <= days * 86_400_000;
}

/**
 * Picks which parsed item (if any) should be locked to a known contact when the bulk
 * notes panel is opened from that contact's profile (`lockedParticipantId`). Pure so it
 * can be unit-smoked without a model: duplicate-id match wins, then a case-insensitive
 * name match, then — only when nothing else can be reasonably confident, exactly one
 * parsed participant — that lone item. Returns the item's `key`, or null when no item
 * should be locked.
 */
export function pickLockedParticipant(
  items: { key: string; name: string | null; duplicateIds: string[] }[],
  locked: { id: string; name: string }
): string | null {
  const byDuplicate = items.find((item) => item.duplicateIds.includes(locked.id));
  if (byDuplicate) return byDuplicate.key;

  const lockedName = locked.name.trim().toLowerCase();
  const byName = items.find((item) => (item.name || "").trim().toLowerCase() === lockedName);
  if (byName) return byName.key;

  if (items.length === 1) return items[0]!.key;

  return null;
}
