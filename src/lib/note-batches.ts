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

/**
 * How soon to follow up, by how close you are. The review card no longer asks for a day
 * count: closeness is the one number the person sets, and the cadence falls out of it.
 * Closer people get shorter windows — a mentor you saw this week should not sit for six
 * months, and someone you barely know does not need a fortnightly nudge.
 */
export const FOLLOW_UP_DAYS_BY_CLOSENESS: Readonly<Record<1 | 2 | 3 | 4 | 5, number>> = {
  5: 14,
  4: 30,
  3: 60,
  2: 90,
  1: 180,
};

const MAX_AI_FOLLOW_UP_DAYS = 365;

/**
 * The follow-up window for one person: the model's suggestion when the notes implied a
 * timeframe ("call her next week" → 7), else the closeness table. The model's number wins
 * because it came from the notes; the table is what we assume when the notes said nothing.
 */
export function followUpDaysFor(closeness: number | null | undefined, aiDays: number | null | undefined): number {
  if (typeof aiDays === "number" && Number.isFinite(aiDays)) {
    const days = Math.round(aiDays);
    if (days >= 1 && days <= MAX_AI_FOLLOW_UP_DAYS) return days;
  }
  const level = clampLevel(closeness);
  return level ? FOLLOW_UP_DAYS_BY_CLOSENESS[level] : DEFAULT_FOLLOW_UP_WINDOW_DAYS;
}

/**
 * Whether an accepted person gets a follow-up reminder at all. Decided here rather than
 * with a checkbox: the model already said whether the notes call for a follow-up, and
 * closeness plus relevance-to-goals say whether the relationship is worth keeping warm.
 *
 *   - the notes themselves recommend a follow-up → yes, whatever the scores
 *   - goals were scored (relevance is a number): yes when either score is a 5, or the two
 *     together reach 6 — so a real conversation with someone plausibly useful (3 + 3)
 *     qualifies and a one-off met-once tangent (2 + 2) does not
 *   - no goals on file (relevance null): yes from "real conversation" up
 */
export function shouldCreateFollowUp(
  closeness: number | null | undefined,
  relevance: number | null | undefined,
  aiRecommends: boolean
): boolean {
  if (aiRecommends) return true;
  const c = clampLevel(closeness) ?? 2;
  const r = clampLevel(relevance);
  if (r == null) return c >= 3;
  if (c === 5 || r === 5) return true;
  return c + r >= 6;
}

function clampLevel(value: number | null | undefined): 1 | 2 | 3 | 4 | 5 | null {
  if (value == null || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  return (n < 1 ? 1 : n > 5 ? 5 : n) as 1 | 2 | 3 | 4 | 5;
}
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
