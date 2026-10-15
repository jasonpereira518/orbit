import { NOTES_TUNING, notesKindQuestion } from "@/lib/decisions/catalog";
import { decideEach, type Engines } from "@/lib/decisions/engine";

/**
 * The docs the cloud-notes rules could not call. Jev first, then the person's own fast model;
 * with neither, the rules' `maybe` stands and `offer` is null — the caller decides what an
 * unanswered maybe means.
 */
export async function decideNoteDocs(
  engines: Engines,
  docs: ReadonlyArray<{ name: string; head: string }>,
): Promise<Array<{ offer: boolean | null; engine: "jev" | "llm" | "rules" }>> {
  if (docs.length === 0) return [];
  const decided = await decideEach(
    engines,
    { engines: ["jev", "llm"], budgetMs: NOTES_TUNING.budgetMs, cacheDays: NOTES_TUNING.cacheDays },
    {
      operation: "notes.detect",
      items: docs,
      chunkSize: NOTES_TUNING.chunkSize,
      concurrency: NOTES_TUNING.concurrency,
      state: (chunk) => ({ docs: Object.fromEntries(chunk.map(({ key, item }) => [key, { title: item.name, first_lines: item.head }])) }),
      question: notesKindQuestion,
    },
  );
  return decided.map((d) =>
    d.engine === "rules" ? { offer: null, engine: "rules" } : { offer: d.answer.probability >= NOTES_TUNING.offerAtOrAbove, engine: d.engine },
  );
}
