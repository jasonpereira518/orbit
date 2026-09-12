/**
 * Client-safe shapes for a parsed capture. No runtime imports: the review UI is a client
 * component and anything reachable from `@/db` would drag `node:fs` into its bundle.
 */
import type { CaptureParseHints, ParsedNote, SharedNoteContext } from "@/lib/ai";
import type { RejectedCounts } from "@/lib/date-commitment-extract";
import type { DateBasis } from "@/lib/relative-date";
import type { ReminderActionKind } from "@/db/schema";
import type { PreviewMention } from "@/lib/note-batches";

export type BulkNoteDuplicate = {
  id: string;
  fullName: string;
  company: string | null;
  title: string | null;
  reason: string;
  confidence: number;
};

export type BulkNotePersonPreview = {
  key: string;
  notes: string;
  parsed: ParsedNote;
  duplicates: BulkNoteDuplicate[];
  suggestedMergeId: string | null;
  /** Shared group/event notes folded into this person's save payload. */
  sharedNoteTexts: string[];
  interactionDate: string | null;
  interactionType: string | null;
};

/** A dated commitment awaiting the user's review, shaped for the client. */
export type SuggestedReminderPreview = {
  key: string;
  title: string;
  description: string | null;
  rawDatePhrase: string;
  /** YYYY-MM-DD, so the date input round-trips without timezone drift. */
  dueDateIso: string;
  yearInferred: boolean;
  personName: string | null;
  actionKind: ReminderActionKind;
  confidenceScore: number;
  sourceExcerpt: string;
  dateBasis: DateBasis;
  anchorIso: string;
};

/** A person the note only referred to, with enough detail to offer as a contact later. */
export type MentionedOnlyPerson = {
  name: string;
  context: string | null;
  company: string | null;
};

export type AnchorBasis = "note" | "hint" | "upload";

/** What one parse of a note produces — the `ok` payload of `parseBulkCaptureNotes`. */
export type CaptureParseResult = {
  items: BulkNotePersonPreview[];
  sharedNotes: SharedNoteContext[];
  interactionDate: string | null;
  interactionType: string;
  anchorIso: string;
  anchorBasis: AnchorBasis;
  hints: CaptureParseHints;
  /** The corpus the model read; the hash is its dedupe key. Server-computed, never client-forged. */
  sourceText: string;
  sourceHash: string;
  suggestedReminders: SuggestedReminderPreview[];
  suggestionsSkipped: RejectedCounts;
  mentions: PreviewMention[];
  mentionedOnly: MentionedOnlyPerson[];
};

// --- the durable capture job ----------------------------------------------------------

/**
 * Where a capture job is in its life. Forward-only except for the reviewing ↔ ready
 * pair (Back on the first card clears the only decision).
 *
 *   ingesting   media is being transcribed inside the upload request
 *   transcribed text is ready; waiting for the person to press Extract
 *   queued      Extract pressed; no runner has claimed it yet
 *   extracting  a runner owns it (`claim_token`), the model is reading
 *   ready       people are extracted, nobody has decided anything
 *   reviewing   at least one card was decided
 *   saving      Save pressed; a runner owns the write
 *   saved | failed | discarded — terminal
 */
export type CaptureJobStatus =
  | "ingesting"
  | "transcribed"
  | "queued"
  | "extracting"
  | "ready"
  | "reviewing"
  | "saving"
  | "saved"
  | "failed"
  | "discarded";

export const ACTIVE_CAPTURE_JOB_STATUSES: readonly CaptureJobStatus[] = [
  "ingesting",
  "transcribed",
  "queued",
  "extracting",
  "ready",
  "reviewing",
  "saving",
];

export type CaptureSourceKind = "messy" | "voice" | "meeting" | "scan" | "phone";

/** One transcribed block of media, in the order it arrived. */
export type CaptureIngestedBlock = { text: string; source: string };

/** A digest item from a recorded meeting, offered as an extra reminder on the summary. */
export type CaptureMeetingExtra = {
  key: string;
  kind: "action" | "blocker" | "question";
  title: string;
  ownerName: string | null;
  sourceExcerpt: string | null;
};

/** What the runner stores once the parse is done. `CaptureParseResult` minus the corpus. */
export type CaptureJobResult = Omit<CaptureParseResult, "sourceText" | "sourceHash"> & {
  meetingExtras?: CaptureMeetingExtra[];
};

export type CaptureDecisionKind = "accept" | "reject" | "skip";

/** The editable fields on a review card, as the person left them. */
export type CapturePersonEdits = {
  name: string | null;
  company: string | null;
  role: string | null;
  metAt: string | null;
  summary: string | null;
};

/**
 * One card's outcome. Follow-up days and "remind me" are deliberately absent: both are
 * derived at save time from closeness and relevance (`src/lib/note-batches.ts`).
 */
export type CaptureDecision = {
  decision: CaptureDecisionKind;
  /** Position in `result.items` — also the person's planet. */
  index: number;
  mergeContactId: string | null;
  relationshipScore: number;
  tagNames: string[];
  edits?: Partial<CapturePersonEdits>;
  decidedAt: string;
};

/** `decisions` column: person key → decision, plus one reserved key for the meeting ticks. */
export type CaptureDecisions = Record<string, CaptureDecision> & {
  __meeting?: { extraReminderKeys: string[] } & Partial<CaptureDecision>;
};

export const CAPTURE_MEETING_DECISION_KEY = "__meeting";

export type IgnoredPersonReason = "rejected" | "skipped" | "mentioned";
