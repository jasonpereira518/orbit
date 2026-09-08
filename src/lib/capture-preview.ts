/**
 * The shapes capture hands the browser between parsing and saving, plus the one function
 * that names a person row.
 *
 * Deliberately free of runtime imports. `bulk-notes-panel.tsx` is a client component, and
 * anything it imports that transitively reaches `@/db` fails the build with a `node:fs`
 * chunking error that names neither file. Every import below is `import type`, so nothing
 * survives compilation and the client can pull from here safely; the server-side pipeline
 * lives in `capture-parse.ts`.
 */

import type { ReminderActionKind } from "@/db/schema";
import type { ParsedNote } from "@/lib/ai";
import type { DateBasis } from "@/lib/relative-date";

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

/**
 * The identity of a person row, from their position in the parse and their name.
 *
 * One function rather than an inline template literal because the streaming path names each
 * person twice: once in the `roster` event that paints a skeleton row, and again on the
 * `person` event that fills it in. If those two disagreed the row would never be matched
 * and the list would show every person twice.
 */
export function personPreviewKey(index: number, name: string | null | undefined): string {
  return `${index}-${name || "person"}`;
}
