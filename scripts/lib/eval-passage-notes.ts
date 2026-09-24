/**
 * The notes behind the passage evals, seeded one way for every eval that needs them.
 *
 * `eval-retrieval.ts` scores passage search on these notes; the `research` task in
 * `eval-ai.ts` scores whole answers that depend on them. One seeding path, so the two can
 * never disagree about what the user wrote — and indexed through the REAL sweep
 * (`backfillMemoryChunks`), not by calling the chunker directly, so an eval fails if the path
 * production uses to index history stops working.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../src/db";
import { interactions } from "../../src/db/schema";
import { backfillMemoryChunks } from "../../src/lib/memory-backfill";

export type PassageFixture = {
  notes: Array<{ id: string; email: string; date: string; type: string; text: string; pad?: number }>;
  cases: Array<{
    kind: string;
    question: string;
    expect: string[];
    forbid?: string[];
    after?: string;
    before?: string;
    person?: string;
  }>;
};

export function loadPassageFixture(dir: string): PassageFixture {
  return JSON.parse(readFileSync(join(dir, "passage-search-eval.json"), "utf8")) as PassageFixture;
}

/**
 * Words that appear in no eval question, prepended to a note to bury its fact past any head
 * slice. Varied sentences rather than one repeated, so the chunker's boundaries are real.
 */
export function passageFiller(chars: number): string {
  const lines = [
    "We caught up on family, travel and the usual weekend plans.",
    "The weather was grey and the coffee was better than last time.",
    "There was a long tangent about a television series neither of us finished.",
    "We compared notes on commuting and on the new train timetable.",
  ];
  let out = "";
  for (let i = 0; out.length < chars; i++) out += `${lines[i % lines.length]} `;
  return out;
}

/**
 * Write every fixture note as an interaction and index it. Returns interaction id → note id,
 * so a scorer can tell which note a passage came from.
 */
export async function seedPassageNotes(
  userId: string,
  fixture: PassageFixture,
  contactIdByEmail: Map<string, string>
): Promise<Map<string, string>> {
  const db = await getDb();
  const noteIdBySource = new Map<string, string>();
  for (const note of fixture.notes) {
    const contactId = contactIdByEmail.get(note.email);
    if (!contactId) {
      throw new Error(`passage fixture names ${note.email}, which contact-search-eval.json does not have`);
    }
    const [row] = await db
      .insert(interactions)
      .values({
        userId,
        contactId,
        interactionType: note.type,
        rawNotes: `${passageFiller(note.pad ?? 0)}${note.text}`,
        interactionDate: new Date(`${note.date}T12:00:00Z`),
      })
      .returning();
    noteIdBySource.set(row.id, note.id);
  }
  for (let pass = 0; pass < 20; pass++) {
    const r = await backfillMemoryChunks(userId);
    if (r.remaining === 0) break;
  }
  return noteIdBySource;
}
