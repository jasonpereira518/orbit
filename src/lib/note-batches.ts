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
 * The follow-up window for one person, in order of what actually knows best:
 *
 *   1. a cadence the person STATED ("check in monthly") — they said the interval out loud
 *   2. the model's suggestion when the notes implied a timeframe ("call her next week" → 7)
 *   3. the closeness table, which is what we assume when the notes said nothing
 *
 * Cadence outranks the model deliberately. The model's number is an inference drawn from the
 * same sentence the cadence was copied verbatim out of, so when the two disagree it is the
 * inference that is wrong.
 */
export function followUpDaysFor(
  closeness: number | null | undefined,
  aiDays: number | null | undefined,
  cadenceDays?: number | null
): number {
  if (typeof cadenceDays === "number" && Number.isFinite(cadenceDays)) {
    const days = Math.round(cadenceDays);
    if (days >= 1 && days <= MAX_AI_FOLLOW_UP_DAYS) return days;
  }
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
    opportunities: [],
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

/**
 * Words that say when or to whom, not what. "Follow up with Priya next week about the PM
 * role" and "Follow up with Priya about the PM role" are one task; the difference is timing.
 */
const TITLE_NOISE = new Set([
  "a", "an", "the", "to", "with", "about", "for", "on", "of", "and", "re", "at", "in", "by", "up",
  "my", "me", "her", "his", "him", "their", "them", "she", "he", "they", "it",
  "next", "this", "week", "weeks", "month", "today", "tomorrow", "soon", "later",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

function titleWords(s: string): Set<string> {
  return new Set(
    normalizeTitle(s)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !TITLE_NOISE.has(w))
  );
}

/**
 * The same thing to do, worded differently: substring-equal (the old `titlesCollide`
 * rule), or at least 80% of the shorter title's content words appear in the longer one.
 */
export function titlesNearDuplicate(a: string, b: string): boolean {
  if (titlesCollide(a, b)) return true;
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (!wa.size || !wb.size) return false;
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  let shared = 0;
  for (const w of small) if (large.has(w)) shared += 1;
  return shared / small.size >= 0.8;
}

/** How far after a window reminder's default date a dated commitment may land and still replace it. */
export const SUPERSEDE_AFTER_DAYS = 7;

/**
 * The save's collision rule, shared with the review's reminder count. A `window` draft (an
 * action item or the fallback follow-up) carries a date Orbit chose, not one the user said,
 * so it yields to a dated draft for the same contact with a near-duplicate title whose date
 * is earlier than the window date or at most `SUPERSEDE_AFTER_DAYS` after it. The audit's
 * pair — Sep 21 from "next week" against the Sep 29 default — is 8 days EARLIER, which is
 * why this is not a symmetric window. Dated drafts are never dropped here.
 */
export function dropSupersededWindowDrafts<
  T extends { title: string; dueDate: Date; dateBasis: ReminderDateBasis | null }
>(drafts: readonly T[], contactOf: (d: T) => string | null): T[] {
  const limitMs = SUPERSEDE_AFTER_DAYS * 86_400_000;
  return drafts.filter((d) => {
    if (d.dateBasis !== "window") return true;
    return !drafts.some(
      (other) =>
        other !== d &&
        other.dateBasis !== "window" &&
        contactOf(other) === contactOf(d) &&
        titlesNearDuplicate(other.title, d.title) &&
        other.dueDate.getTime() - d.dueDate.getTime() <= limitMs
    );
  });
}

export type PlannedReminder = {
  kind: "action_item" | "dated" | "follow_up";
  /** The person's lowercased name — contacts have no ids before the save. */
  contactKey: string | null;
  title: string;
  dueDate: Date;
  dateBasis: ReminderDateBasis;
};
export type ReminderPlanParticipant = {
  name: string | null;
  actionItems: readonly string[];
  createReminder: boolean;
  followUpDays: number | null;
  followUpTitle: string | null;
};
export type ReminderPlanCommitment = { title: string; dueDateIso: string; dateBasis: ReminderDateBasis; personName: string | null };

/** Mirrors `MAX_ACTION_ITEMS_PER_INTERACTION` in src/lib/action-items.ts, which reaches @/db and cannot be imported here. */
const PLAN_MAX_ACTION_ITEMS = 10;

function planNameKey(name: string | null | undefined): string | null {
  return name?.trim().toLowerCase() || null;
}
function planIsoNoon(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0, 0);
}
function planDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Every reminder `saveNoteBatch` would write for a fresh batch, without a database: step 1a
 * (one window reminder per distinct action item), step 2 (dated commitments, bound to a
 * participant by name), step 3 (the fallback follow-up for a person with no other draft),
 * step 4 (`dropSupersededWindowDrafts`) and step 5's itemHash de-duplication. Meeting digest
 * items are not planned; callers add their tick count. `smoke-capture-reminder-count`
 * proves this equals what the save writes.
 */
export function planReminders(input: {
  anchorIso: string;
  participants: readonly ReminderPlanParticipant[];
  commitments: readonly ReminderPlanCommitment[];
}): PlannedReminder[] {
  const anchor = planIsoNoon(input.anchorIso);
  const names = new Set(input.participants.map((p) => planNameKey(p.name)).filter((k): k is string => Boolean(k)));
  const drafts: PlannedReminder[] = [];

  for (const p of input.participants) {
    const key = planNameKey(p.name);
    const seen = new Set<string>();
    for (const raw of p.actionItems) {
      const text = raw.replace(/^ +| +$/g, "");
      const lowered = text.toLowerCase();
      if (!text || seen.has(lowered)) continue;
      if (seen.size >= PLAN_MAX_ACTION_ITEMS) break;
      seen.add(lowered);
      drafts.push({ kind: "action_item", contactKey: key, title: text, dueDate: windowDueDate(anchor), dateBasis: "window" });
    }
  }
  for (const c of input.commitments) {
    const key = planNameKey(c.personName);
    drafts.push({ kind: "dated", contactKey: key && names.has(key) ? key : null, title: c.title, dueDate: planIsoNoon(c.dueDateIso), dateBasis: c.dateBasis });
  }
  for (const p of input.participants) {
    const key = planNameKey(p.name);
    if (!p.createReminder || !key || drafts.some((d) => d.contactKey === key)) continue;
    drafts.push({
      kind: "follow_up",
      contactKey: key,
      title: p.followUpTitle || `Follow up with ${p.name}`,
      dueDate: windowDueDate(anchor, p.followUpDays || DEFAULT_FOLLOW_UP_WINDOW_DAYS),
      dateBasis: "window",
    });
  }

  const hashes = new Set<string>();
  return dropSupersededWindowDrafts(drafts, (d) => d.contactKey).filter((d) => {
    if (d.kind === "action_item") return true;
    const hash = `${planDayKey(d.dueDate)}|${d.title.trim().toLowerCase()}`;
    if (hashes.has(hash)) return false;
    hashes.add(hash);
    return true;
  });
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
