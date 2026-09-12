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
