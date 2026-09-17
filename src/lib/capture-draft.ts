/**
 * The capture page's unsaved notes, kept in localStorage as they are typed, so a closed tab,
 * a reload or a failed extraction never costs someone a page of notes.
 *
 * localStorage rather than the server on purpose: a draft is by definition something the
 * person has not decided to keep, and writing every keystroke of prose about named people to
 * the database would turn "I was just typing" into a record. It stays on the device, scoped
 * by account, and is thrown away on save or after `DRAFT_TTL_MS`.
 *
 * Pure apart from the `Storage` it is handed, so `scripts/smoke-capture-draft.ts` can drive
 * it with an in-memory one.
 */
import { sanitizeMentionPicks, type MentionPick } from "@/lib/mentions/mention-picks";

export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a draft may keep its photos. Unsaved capture photos are pruned on the server
 * after 24 hours (`UNATTACHED_PHOTO_TTL_MS` in `capture-photos.ts`, which this file must not
 * import: it reaches the database). Stopping short of that means a restored draft never
 * shows a thumbnail whose photo is already gone.
 */
export const DRAFT_PHOTO_TTL_MS = 20 * 60 * 60 * 1000;

const KEY_PREFIX = "orbit:capture-draft:v1";

export type CaptureDraft = {
  notes: string;
  /** `ingestCaptureMedia`'s source labels, so the saved capture is labelled correctly. */
  sources: string[];
  photoIds: string[];
  /**
   * Contacts named with `@`, kept so a restored draft's tokens are still green and still
   * link on save. Without them the text comes back and the links quietly do not.
   *
   * Run through `sanitizeMentionPicks` on the way OUT as well as in: localStorage is the
   * user's own machine and anything there can be edited, and this ends up as a contact id
   * in a write. The shape check is cheap; skipping it is how a draft becomes an injection
   * point for the price of an open devtools tab.
   */
  mentionPicks: MentionPick[];
  /** Epoch ms of the last write. */
  savedAt: number;
};

/**
 * One draft per account and per person: notes started while logging with Sarah are not
 * the notes on the general capture page.
 */
export function captureDraftKey(userId: string, contactId: string | null) {
  return `${KEY_PREFIX}:${userId}:${contactId ?? "general"}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * The draft under `key`, or null when there is none worth restoring — expired, empty,
 * or not something this code wrote. Never throws: storage that is full, disabled or
 * holding junk just means there is nothing to restore.
 */
export function readCaptureDraft(
  storage: Pick<Storage, "getItem" | "removeItem">,
  key: string,
  now = Date.now()
): CaptureDraft | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeRemove(storage, key);
    return null;
  }
  const d = parsed as Partial<CaptureDraft> | null;
  if (
    !d ||
    typeof d.notes !== "string" ||
    typeof d.savedAt !== "number" ||
    !isStringArray(d.sources) ||
    !isStringArray(d.photoIds)
  ) {
    safeRemove(storage, key);
    return null;
  }
  // Optional on purpose: drafts written before `@`-picks existed are still good drafts, and
  // throwing one away would lose a page of notes to a schema change.
  const mentionPicks = sanitizeMentionPicks(d.mentionPicks);
  if (now - d.savedAt > DRAFT_TTL_MS) {
    safeRemove(storage, key);
    return null;
  }

  const photoIds = now - d.savedAt > DRAFT_PHOTO_TTL_MS ? [] : d.photoIds;
  if (!d.notes.trim() && !photoIds.length) {
    safeRemove(storage, key);
    return null;
  }
  return { notes: d.notes, sources: d.sources, photoIds, mentionPicks, savedAt: d.savedAt };
}

/**
 * Write the draft, or remove it when there is nothing in it — an empty textarea is not a
 * draft, and leaving one behind would bring back a "restored" banner over nothing.
 */
export function writeCaptureDraft(
  storage: Pick<Storage, "setItem" | "removeItem">,
  key: string,
  draft: Omit<CaptureDraft, "savedAt">,
  now = Date.now()
) {
  if (!draft.notes.trim() && !draft.photoIds.length) {
    safeRemove(storage, key);
    return;
  }
  try {
    storage.setItem(
      key,
      JSON.stringify({
        ...draft,
        mentionPicks: sanitizeMentionPicks(draft.mentionPicks),
        savedAt: now,
      } satisfies CaptureDraft)
    );
  } catch {
    // Full or disabled storage (private browsing on some browsers). The page still works;
    // it just cannot promise to remember.
  }
}

export function clearCaptureDraft(storage: Pick<Storage, "removeItem">, key: string) {
  safeRemove(storage, key);
}

function safeRemove(storage: Pick<Storage, "removeItem">, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // Nothing to do; see `writeCaptureDraft`.
  }
}
