/**
 * Passage retrieval, end to end, against a real database.
 *
 * This is the proof for the claim the whole phase rests on: a fact the user wrote 3,000
 * characters into a note is findable — by its own words, on its own date, without naming the
 * person it is about. Before this, `interactions` had no full-text index at all and a note
 * could only be reached by first reaching its contact.
 *
 * It runs on PGlite, which has NO pgvector, so everything here exercises the lexical-only
 * path. That is deliberate and not a compromise: accounts on an Anthropic key get no
 * embeddings either (there is no Anthropic embeddings API), so this IS production for them.
 *
 * Run: npx tsx scripts/smoke-memory-search.ts
 */
import "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, memoryChunks } from "../src/db/schema";
import {
  buildMemoryChunks,
  deleteMemoryChunks,
  repointMemoryChunks,
  syncMemoryChunks,
} from "../src/lib/memory-chunks";
import { backfillMemoryChunks, pruneOrphanedMemoryChunks } from "../src/lib/memory-backfill";
import { searchMemories } from "../src/lib/memory-search";
import { logNoteInteractionForUser } from "../src/lib/contact-writes";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-memory-search-user";
const OTHER = "smoke-memory-search-intruder";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const FILLER =
  "We went over the usual quarterly numbers and the hiring plan for the platform team. ";
function padded(fact: string, depth: number): string {
  let head = "";
  while (head.length < depth) head += FILLER;
  return `${head}${fact} ${FILLER.repeat(3)}`;
}

async function main() {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(memoryChunks).where(eq(memoryChunks.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
    await ensureUserSettings(u);
  }

  const [priya] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Priya Raman", company: "Fintech Co" })
    .returning();
  const [sam] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Sam Okafor", company: "Acme" })
    .returning();

  // The buried fact — the exact shape of the bug this phase exists for.
  const marchNote = padded("She is raising a Series A for her fintech startup.", 3000);
  const marchSourceId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  await syncMemoryChunks(USER, {
    sourceKind: "interaction",
    sourceId: marchSourceId,
    drafts: buildMemoryChunks({
      text: marchNote,
      occurredAt: new Date("2026-03-12T10:00:00Z"),
      kindLabel: "Coffee",
      contactId: priya.id,
      contactName: "Priya Raman",
      contactIds: [],
    }),
  });

  // A second note, later, about someone else and something else — so a match has to be
  // earned rather than being the only row in the table.
  const juneSourceId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  await syncMemoryChunks(USER, {
    sourceKind: "interaction",
    sourceId: juneSourceId,
    drafts: buildMemoryChunks({
      text: "Sam walked me through their Kubernetes migration and the on-call rotation.",
      occurredAt: new Date("2026-06-02T10:00:00Z"),
      kindLabel: "Call",
      contactId: sam.id,
      contactName: "Sam Okafor",
      contactIds: [],
    }),
  });

  // --- the buried fact is findable by its own words --------------------------------------

  const raised = await searchMemories(USER, { query: "who is raising a Series A?" });
  check("a fact buried 3,000 chars into a note is retrievable", raised.length > 0, String(raised.length));
  check(
    "and the passage returned actually contains it",
    raised.some((m) => m.snippet.toLowerCase().includes("series a")),
    raised.map((m) => m.snippet.slice(0, 80)).join(" | ")
  );
  check(
    "the passage carries the contact it is about, so an answer can name them",
    raised[0]?.contactIds.includes(priya.id) === true,
    JSON.stringify(raised[0]?.contactIds)
  );
  check(
    "and its provenance, so a citation can point at the source",
    raised[0]?.sourceKind === "interaction" && raised[0]?.sourceId === marchSourceId,
    `${raised[0]?.sourceKind}/${raised[0]?.sourceId}#${raised[0]?.chunkIndex}`
  );
  check(
    "the lexical arm is what found it — this is the no-embeddings path",
    raised[0]?.matchedArms.includes("lexical") === true,
    JSON.stringify(raised[0]?.matchedArms)
  );

  // --- no person in the question, and a date range ----------------------------------------

  const MARCH = { after: new Date("2026-03-01T00:00:00Z"), before: new Date("2026-03-31T23:59:59Z") };

  // No person named anywhere in this question — the thing that had no query plan at all
  // before, because a note could only be reached through its contact.
  const inMarch = await searchMemories(USER, { query: "Series A", ...MARCH });
  check(
    "a date-scoped question with nobody named in it finds the note in that month",
    inMarch.length > 0 && inMarch.every((m) => m.occurredAt !== null),
    String(inMarch.length)
  );

  const juneWordsUnscoped = await searchMemories(USER, { query: "Kubernetes migration" });
  const juneWordsInMarch = await searchMemories(USER, { query: "Kubernetes migration", ...MARCH });
  check(
    "the June note is findable by its words when no range is given",
    juneWordsUnscoped.length > 0,
    String(juneWordsUnscoped.length)
  );
  check(
    "and the date range — not a failure to match — is what excludes it from March",
    juneWordsInMarch.length === 0,
    JSON.stringify(juneWordsInMarch.map((m) => m.occurredAt))
  );

  // --- scoping by person -------------------------------------------------------------------

  const samOnly = await searchMemories(USER, { query: "rotation", contactIds: [sam.id] });
  const priyaOnly = await searchMemories(USER, { query: "rotation", contactIds: [priya.id] });
  check("scoping to a person finds their passage", samOnly.length > 0, String(samOnly.length));
  check("and returns nothing for someone it is not about", priyaOnly.length === 0, String(priyaOnly.length));

  // --- tenancy ------------------------------------------------------------------------------

  const intruder = await searchMemories(OTHER, { query: "Series A" });
  check("another account sees none of it", intruder.length === 0, String(intruder.length));

  // --- re-chunking is idempotent and carries embeddings forward -----------------------------

  const before = await db.query.memoryChunks.findMany({
    where: eq(memoryChunks.userId, USER),
    columns: { id: true },
  });
  const again = await syncMemoryChunks(USER, {
    sourceKind: "interaction",
    sourceId: marchSourceId,
    drafts: buildMemoryChunks({
      text: marchNote,
      occurredAt: new Date("2026-03-12T10:00:00Z"),
      kindLabel: "Coffee",
      contactId: priya.id,
      contactName: "Priya Raman",
      contactIds: [],
    }),
  });
  const after = await db.query.memoryChunks.findMany({
    where: eq(memoryChunks.userId, USER),
    columns: { id: true },
  });
  check(
    "re-syncing the same note does not accumulate rows",
    before.length === after.length,
    `${before.length} -> ${after.length}`
  );
  check("and reports what it wrote", again.written > 0, JSON.stringify(again));

  // Pretend the chunks were embedded, then re-sync unchanged text: the vectors must survive,
  // or every trivial edit re-bills the user for the whole note.
  // The state the backfill leaves behind: embedded_hash caught up to content_hash, with a
  // vector stored. Raw SQL because it is a column-to-column assignment.
  await db.execute(sql`update memory_chunks
       set embedded_hash = content_hash, embedding = '[0.1,0.2]'::jsonb
     where user_id = ${USER} and source_id = ${marchSourceId}::uuid`);
  const reSynced = await syncMemoryChunks(USER, {
    sourceKind: "interaction",
    sourceId: marchSourceId,
    drafts: buildMemoryChunks({
      text: marchNote,
      occurredAt: new Date("2026-03-12T10:00:00Z"),
      kindLabel: "Coffee",
      contactId: priya.id,
      contactName: "Priya Raman",
      contactIds: [],
    }),
  });
  check(
    "an unchanged note keeps its embeddings instead of paying to make them again",
    reSynced.reused === reSynced.written && reSynced.written > 0,
    JSON.stringify(reSynced)
  );

  // --- a merge must rewrite the array, or the note stops being findable ---------------------

  await repointMemoryChunks(USER, sam.id, priya.id);
  const merged = await searchMemories(USER, { query: "rotation", contactIds: [priya.id] });
  check(
    "after a merge the loser's passages are findable from the winner",
    merged.length > 0,
    String(merged.length)
  );
  const stale = await searchMemories(USER, { query: "rotation", contactIds: [sam.id] });
  check("and no longer from the merged-away id", stale.length === 0, String(stale.length));

  // --- deletion ------------------------------------------------------------------------------

  await deleteMemoryChunks(USER, { sourceKind: "interaction", sourceIds: [marchSourceId] });
  const gone = await searchMemories(USER, { query: "Series A" });
  check("deleting a source removes its passages", gone.length === 0, String(gone.length));

  // --- writing a note indexes it, without anyone asking ---------------------------------------

  await logNoteInteractionForUser(USER, {
    contactId: priya.id,
    interactionType: "note",
    rawNotes: "She mentioned her sister is moving to Lisbon in the autumn.",
    interactionDate: new Date("2026-05-04T09:00:00Z"),
    externalId: `smoke:${Date.now()}`,
  }, { skipRevalidate: true });
  const lisbon = await searchMemories(USER, { query: "Lisbon" });
  check(
    "a note logged through the normal write path is searchable immediately",
    lisbon.length > 0,
    String(lisbon.length)
  );
  check(
    "and it is the note that was just written",
    lisbon[0]?.snippet.includes("Lisbon"),
    lisbon[0]?.snippet
  );

  // --- the sweep picks up what the bulk paths skipped ------------------------------------------

  // `skipEmbedding` is what an import passes: no inline indexing, by design.
  const bulk = await logNoteInteractionForUser(
    USER,
    {
      contactId: sam.id,
      interactionType: "meeting",
      rawNotes: "Imported from the calendar: quarterly review with the infrastructure group.",
      interactionDate: new Date("2026-04-18T09:00:00Z"),
      externalId: `smoke-bulk:${Date.now()}`,
    },
    { skipEmbedding: true, skipRevalidate: true }
  );
  const beforeSweep = await searchMemories(USER, { query: "infrastructure group" });
  check(
    "a bulk-written note is NOT indexed inline — imports must not pay per row",
    beforeSweep.length === 0,
    String(beforeSweep.length)
  );

  const swept = await backfillMemoryChunks(USER);
  check("the sweep finds and indexes it", swept.indexed > 0, JSON.stringify(swept));
  check("and reports nothing left behind", swept.remaining === 0, JSON.stringify(swept));
  const afterSweep = await searchMemories(USER, { query: "infrastructure group" });
  check("after which it is searchable", afterSweep.length > 0, String(afterSweep.length));

  const sweptAgain = await backfillMemoryChunks(USER);
  check(
    "a second sweep does no work — the claim is an anti-join, not a flag that can drift",
    sweptAgain.indexed === 0 && sweptAgain.remaining === 0,
    JSON.stringify(sweptAgain)
  );

  // --- a deleted note must not leave a quotable passage behind ---------------------------------

  await db.delete(interactions).where(eq(interactions.id, bulk.row.id));
  const stillThere = await searchMemories(USER, { query: "infrastructure group" });
  check(
    "deleting the interaction alone leaves the passage orphaned — which is why the prune exists",
    stillThere.length > 0,
    String(stillThere.length)
  );
  const pruned = await pruneOrphanedMemoryChunks(USER);
  check("the prune removes it", pruned > 0, String(pruned));
  const afterPrune = await searchMemories(USER, { query: "infrastructure group" });
  check("and the deleted note is no longer quotable", afterPrune.length === 0, String(afterPrune.length));

  for (const u of [USER, OTHER]) {
    await db.delete(memoryChunks).where(eq(memoryChunks.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll memory-search checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
