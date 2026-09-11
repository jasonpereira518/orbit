/**
 * Pure helpers shared by the save path (src/lib/note-batch-save.ts), the capture action, and
 * the results page. No DB, no AI — everything here is unit-checkable.
 */
import { atLocalNoon } from "@/lib/interaction-date";
import type { CaptureSourceKind, NoteBatchResult, ReminderDateBasis } from "@/db/schema";
import type { MentionMatchedBy } from "@/lib/mention-resolution";
import type { CaptureParseHints } from "@/lib/ai";

export type { CaptureSourceKind, NoteBatchResult, ReminderDateBasis };

const SOURCE_KIND_ORDER: CaptureSourceKind[] = ["voice", "photo", "calendar", "email", "file", "text"];

/**
 * Folds `normalizeCaptureInput`'s `sources` labels (`"voice:rec.wav"`, `"photos:2"`,
 * `"calendar:invite.ics"`, `"text"`...) into the kinds the capture history shows.
 *
 * The labels arrive back from the client with the save, so anything unrecognised is
 * dropped rather than stored: this is a display label and must never become a place to
 * write arbitrary strings. A save with no labels at all was typed, so it reads as text.
 */
export function captureSourceKinds(labels: readonly unknown[] | null | undefined): CaptureSourceKind[] {
  const kinds = new Set<CaptureSourceKind>();
  for (const label of labels ?? []) {
    if (typeof label !== "string") continue;
    const prefix = label.split(":")[0]!.trim().toLowerCase();
    if (prefix === "voice") kinds.add("voice");
    else if (prefix === "photos" || prefix === "photo") kinds.add("photo");
    else if (prefix === "calendar") kinds.add("calendar");
    else if (prefix === "email") kinds.add("email");
    // A bare "text" is what was typed or pasted; "text:notes.md" is an uploaded file.
    else if (prefix === "text") kinds.add(label.includes(":") ? "file" : "text");
    else if (prefix === "file") kinds.add("file");
  }
  if (!kinds.size) kinds.add("text");
  return SOURCE_KIND_ORDER.filter((k) => kinds.has(k));
}

/**
 * The line a capture is recognised by in the history: who it was about. Falls back to the
 * first reminder for a dates-only note ("Board review 15th of October"), then to nothing —
 * the caller shows the excerpt instead.
 */
export function captureHistoryTitle(result: Pick<NoteBatchResult, "participants" | "reminders">): string | null {
  const names = [...new Set(result.participants.map((p) => p.name.trim()).filter(Boolean))];
  if (names.length) {
    const shown = names.slice(0, 2).join(", ");
    return names.length > 2 ? `${shown} +${names.length - 2} more` : shown;
  }
  return result.reminders[0]?.title.trim() || null;
}

/** The start of the notes, whitespace-collapsed and cut on a word boundary. */
export function captureExcerpt(sourceText: string, max = 160): string {
  const flat = sourceText.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

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

/**
 * Folds the locked-profile participant into `hints.seedPeople` alongside whatever
 * `.ics`/`.eml` ingestion (or a prior call) already put there, rather than replacing
 * that list outright — a naive overwrite would silently drop real attendees. The
 * de-dupe is case/whitespace-insensitive on name so re-deriving hints for the same
 * lock doesn't pile up duplicate seed entries.
 */
export function withLockedSeedPerson(
  hints: CaptureParseHints | null,
  name: string
): CaptureParseHints {
  const existing = hints?.seedPeople ?? [];
  const normalized = name.trim().toLowerCase();
  const already = existing.some(
    (p) => (p.name ?? "").trim().toLowerCase() === normalized
  );
  return {
    ...hints,
    seedPeople: already ? existing : [...existing, { name }],
  };
}
