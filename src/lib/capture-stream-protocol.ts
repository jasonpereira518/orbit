/**
 * The wire protocol for a streamed capture parse.
 *
 * Clicking "Extract people" used to await one server action and show a single "Parsing…"
 * label. Behind that label the server runs an identify pass, then N detail passes in
 * batches of four, then an excerpt retry, a concurrent commitment extraction, a full
 * contact load and duplicate matching — five or more sequential model calls on a long note,
 * each with a 45s deadline. This protocol is what makes that visible.
 *
 * Unlike chat, nothing here is a token delta: the events are structural. The ordering the
 * client can rely on is
 *
 *     stage* → roster? → (person | stage)* → result
 *                                          ↘ error
 *
 * `roster` is emitted only on the two-pass path, where the identify call genuinely knows
 * the names before the details exist. Short notes take the single pass, which returns
 * everything at once, and honestly emit stages only — manufacturing a roster there would
 * mean a whole extra model call to tell the user something they are about to see anyway.
 *
 * Pure, and pinned by `scripts/smoke-capture-stream.ts`.
 */

import type { SharedNoteContext } from "@/lib/ai";
import type { RejectedCounts } from "@/lib/date-commitment-extract";
import type { PreviewMention } from "@/lib/note-batches";
import type {
  BulkNotePersonPreview,
  SuggestedReminderPreview,
} from "@/lib/capture-preview";

/**
 * The stages, in the order they occur. `detailing` is the only one that can report a
 * fraction; the rest are indeterminate because there is nothing honest to count.
 */
export type CaptureStage =
  | "reading"
  | "identifying"
  | "detailing"
  | "dating"
  | "matching";

/** A name known before its details are. Enough to paint a row and nothing more. */
export type RosterPerson = {
  key: string;
  name: string;
  company: string | null;
  role: string | null;
};

/**
 * Everything `parseBulkCaptureNotes` returns except `items`, which arrive one at a time as
 * `person` events. Kept as one payload so the save path cannot drift from the action's:
 * `sourceText` and `sourceHash` are recomputed and compared server-side by
 * `confirmBulkCapture`, so they must round-trip byte-for-byte.
 */
export type CaptureStreamResult = {
  sharedNotes: SharedNoteContext[];
  interactionDate: string | null;
  interactionType: string | null;
  anchorIso: string;
  anchorBasis: "note" | "hint" | "upload";
  sourceText: string;
  sourceHash: string;
  suggestedReminders: SuggestedReminderPreview[];
  suggestionsSkipped: RejectedCounts;
  mentions: PreviewMention[];
};

export type CaptureStreamEvent =
  | { type: "stage"; stage: CaptureStage; done?: number; total?: number }
  | { type: "roster"; people: RosterPerson[] }
  | { type: "person"; item: BulkNotePersonPreview }
  | { type: "result"; result: CaptureStreamResult }
  | { type: "error"; message: string };

/** Human copy for each stage. One place, so the route and the panel cannot disagree. */
export const CAPTURE_STAGE_LABEL: Record<CaptureStage, string> = {
  reading: "Reading your notes",
  identifying: "Finding people",
  detailing: "Filling in details",
  dating: "Looking for dates",
  matching: "Checking for duplicates",
};
