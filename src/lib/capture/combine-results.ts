/**
 * Several notes from one upload, folded into one review.
 *
 * Each file in a multi-file upload is read as its own capture job, in the background and in
 * parallel. Reviewing them one job at a time meant opening the upload's queue and walking a
 * deck per file, so once every file has been read `mergeCaptureBatch` folds the ready jobs
 * into one job, built here, and the person reviews a single deck.
 *
 * Folding is concatenation, never deduplication. A person who appears in three notes gets
 * three cards, each carrying its own note: they are three conversations, with three dates,
 * and each becomes its own timeline entry. That is why every card keeps `noteHash` — the
 * save keys a person's interaction by the note it came from, and without it the second
 * note's conversation with the same contact would be skipped as a re-paste of the first.
 *
 * Keys are prefixed per note (`n0:`, `n1:` …) because each job numbered its cards and
 * reminders from zero; unprefixed, two notes' "0-Maya Chen" would be one key, and a
 * decision on one card would land on both.
 *
 * Pure: no database, no clock. Exercised through `mergeCaptureBatchRows` in
 * `scripts/smoke-capture-jobs.ts` ("An upload is reviewed together").
 */
import { hashSourceNote } from "@/lib/suggested-reminder-utils";
import type { AnchorBasis, CaptureJobResult } from "@/lib/capture/types";

export type CombinePart = {
  /** The file's name, shown on each of its cards. */
  label: string | null;
  /** The corpus that job read, and its hash. */
  sourceText: string;
  sourceHash: string;
  result: CaptureJobResult;
};

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

export function combineCaptureResults(parts: readonly CombinePart[]): {
  result: CaptureJobResult;
  sourceText: string;
  sourceHash: string;
} {
  if (!parts.length) throw new Error("Nothing to combine");

  const prefix = (n: number, key: string) => `n${n}:${key}`;

  const items = parts.flatMap((p, n) =>
    p.result.items.map((item) => ({
      ...item,
      key: prefix(n, item.key),
      noteHash: item.noteHash ?? p.sourceHash,
      noteLabel: item.noteLabel ?? p.label,
    }))
  );
  const suggestedReminders = parts.flatMap((p, n) =>
    p.result.suggestedReminders.map((r) => ({ ...r, key: prefix(n, r.key) }))
  );

  // The anchor is the date the notes are about; for several notes, the newest. Every card
  // and reminder keeps its own date, so this only dates the batch row and fills gaps.
  let anchorIso = parts[0]!.result.anchorIso;
  let anchorBasis: AnchorBasis = parts[0]!.result.anchorBasis;
  for (const p of parts) {
    if (p.result.anchorIso > anchorIso) {
      anchorIso = p.result.anchorIso;
      anchorBasis = p.result.anchorBasis;
    }
  }

  const skipped = parts.map((p) => p.result.suggestionsSkipped);
  const phrases = [...new Set(skipped.flatMap((s) => s.relativePhrases ?? []))];

  const result: CaptureJobResult = {
    items,
    sharedNotes: parts.flatMap((p) => p.result.sharedNotes),
    interactionDate: parts.reduce<string | null>((acc, p) => later(acc, p.result.interactionDate), null),
    interactionType: "meeting_note",
    anchorIso,
    anchorBasis,
    // Hints steered each file's own parse; there is no parse of the whole to steer.
    hints: {},
    suggestedReminders,
    suggestionsSkipped: {
      relative: skipped.reduce((s, c) => s + c.relative, 0),
      unverifiable: skipped.reduce((s, c) => s + c.unverifiable, 0),
      past: skipped.reduce((s, c) => s + c.past, 0),
      ...(phrases.length ? { relativePhrases: phrases } : {}),
    },
    mentions: parts.flatMap((p) => p.result.mentions),
    mentionedOnly: parts.flatMap((p) => p.result.mentionedOnly),
    linkedinLookup: null,
  };

  // Headed per file, so the saved batch's text says which note each passage came from.
  const sourceText = parts
    .map((p) => (p.label ? `## ${p.label}\n\n${p.sourceText}` : p.sourceText))
    .join("\n\n---\n\n");
  return { result, sourceText, sourceHash: hashSourceNote(sourceText) };
}
