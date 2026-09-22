/**
 * The passage embedding drain: what makes a note findable by its meaning, not just its words.
 *
 * Driven through the real `runEmbeddingBackfill` with the `embed` seam stubbed, so it runs the
 * actual claim, the conditional write, failure marking and the gate — with no live AI key.
 *
 * The properties pinned here, each of which fails in a way nobody would notice:
 *
 *  - The SWEEP runs before anything that can throw. For an account whose key has no
 *    embeddings API every embedding phase throws by design; if the sweep ran after them,
 *    that account's note history would never become searchable even by its words.
 *  - A passage the provider refuses on its own is recorded and not re-sent, or it would keep
 *    `remaining > 0` and cost a provider call on every run forever.
 *  - An account that can never embed is not a backlog. Counting its passages as remaining
 *    would re-kick the drain for it daily and record a failure the ops sweep alerts on.
 *  - The semantic arm finds a passage that shares NO words with the question — the whole
 *    reason to embed at all — on the no-pgvector fallback, which is local dev and every
 *    account's path until the vectors are copied.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-memory-embedding.ts
 */
import "./smoke/_env";

import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contacts, embeddingFailures, interactions, memoryChunks } from "../src/db/schema";
import type { createEmbeddingsBatch } from "../src/lib/ai";
import {
  accountCanEmbed,
  pendingMemoryChunkCount,
  runEmbeddingBackfill,
} from "../src/lib/embedding-backfill";
import { buildMemoryChunks, syncMemoryChunks } from "../src/lib/memory-chunks";
import { usersWithPendingMemoryWork } from "../src/lib/memory-backfill";
import { searchMemories } from "../src/lib/memory-search";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-memory-embedding-user";
const POISON_USER = "smoke-memory-embedding-poison";
const KEYLESS_USER = "smoke-memory-embedding-keyless";
const SWEEP_USER = "smoke-memory-embedding-sweep";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/**
 * A deterministic stand-in for a provider: the vector depends on which "topic" words the text
 * contains, so two texts about the same thing land near each other and two about different
 * things do not — enough for the semantic arm to have something real to rank.
 */
const TOPICS = ["fundraising", "hiring", "kubernetes"];
function topicVector(text: string): number[] {
  const lower = text.toLowerCase();
  const v = Array(8).fill(0.01);
  TOPICS.forEach((t, i) => {
    if (lower.includes(t) || (t === "fundraising" && /seed round|series a|investor/.test(lower))) v[i] = 1;
  });
  return v;
}
let embedCalls = 0;
const stubEmbed: typeof createEmbeddingsBatch = async (_userId, texts) => {
  embedCalls += texts.length;
  return texts.map(topicVector);
};

async function seedChunks(userId: string, contactId: string, sourceId: string, text: string) {
  await syncMemoryChunks(userId, {
    sourceKind: "interaction",
    sourceId,
    drafts: buildMemoryChunks({
      text,
      occurredAt: new Date("2026-03-12T10:00:00Z"),
      kindLabel: "Note",
      contactId,
      contactName: null,
      contactIds: [],
    }),
  });
}

async function makeContact(userId: string, fullName: string) {
  const db = await getDb();
  // Inserted directly, so no write path stamps `embedding_stale_at` — this suite is about the
  // passage phase, and a stale contact would send the profile phase to a real provider.
  const [row] = await db.insert(contacts).values({ userId, fullName }).returning();
  return row.id;
}

async function main() {
  const db = await getDb();
  for (const u of [USER, POISON_USER, KEYLESS_USER, SWEEP_USER]) {
    await db.delete(embeddingFailures).where(eq(embeddingFailures.userId, u));
    await db.delete(memoryChunks).where(eq(memoryChunks.userId, u));
    await db.delete(interactions).where(eq(interactions.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
    await ensureUserSettings(u);
  }

  // --- the drain embeds passages, and a second pass does nothing ---------------------------

  const ada = await makeContact(USER, "Ada Lovelace");
  await seedChunks(USER, ada, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    "She is closing a seed round with two angel investors next month.");
  await seedChunks(USER, ada, "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    "Walked me through their Kubernetes migration and the on-call rotation.");

  check("passages start pending", (await pendingMemoryChunkCount(USER)) === 2);

  const first = await runEmbeddingBackfill(USER, stubEmbed);
  check("the drain embeds every pending passage", first.passages === 2, JSON.stringify(first));
  check(
    "and reports them apart from contact embeddings, whose meaning is unchanged",
    first.embedded === 0,
    JSON.stringify(first)
  );
  check("nothing is left pending", first.remaining === 0, JSON.stringify(first));

  const caughtUp = rowsOf<{ n: number }>(
    await db.execute(sql`select count(*)::int as n from memory_chunks
      where user_id = ${USER} and embedded_hash = content_hash and embedding is not null`)
  )[0]?.n;
  check("every passage's embedded_hash has caught up with its content", caughtUp === 2, String(caughtUp));

  embedCalls = 0;
  const second = await runEmbeddingBackfill(USER, stubEmbed);
  check(
    "a second pass calls the provider zero times",
    embedCalls === 0 && second.passages === 0,
    `${embedCalls} calls, ${JSON.stringify(second)}`
  );

  // --- the point of embedding: found by meaning, with no word in common ---------------------

  // "raising money" shares no content word with "closing a seed round with two angel
  // investors". The lexical arm cannot find it; only the vector can.
  const byMeaning = await searchMemories(USER, {
    query: "who is raising money",
    embedding: topicVector("fundraising"),
  });
  check(
    "a passage sharing no words with the question is found by the semantic arm",
    byMeaning.some((m) => m.snippet.includes("seed round") && m.matchedArms.includes("semantic")),
    JSON.stringify(byMeaning.map((m) => ({ s: m.snippet.slice(0, 40), a: m.matchedArms })))
  );
  const byWordsOnly = await searchMemories(USER, { query: "who is raising money" });
  check(
    "and the same question without an embedding does not find it — the contrast is the point",
    !byWordsOnly.some((m) => m.snippet.includes("seed round")),
    JSON.stringify(byWordsOnly.map((m) => m.snippet.slice(0, 40)))
  );
  check(
    "the unrelated passage is not dragged in by the meaning arm",
    !byMeaning.some((m) => m.snippet.includes("Kubernetes")),
    JSON.stringify(byMeaning.map((m) => m.snippet.slice(0, 40)))
  );

  // --- an edit re-embeds only what changed ---------------------------------------------------

  await seedChunks(USER, ada, "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    "Walked me through their Kubernetes migration, the on-call rotation, and the hiring plan.");
  embedCalls = 0;
  const afterEdit = await runEmbeddingBackfill(USER, stubEmbed);
  check(
    "editing one note re-embeds that note's passage and nothing else",
    embedCalls === 1 && afterEdit.passages === 1,
    `${embedCalls} calls, ${JSON.stringify(afterEdit)}`
  );

  // --- a passage the provider refuses on its own is recorded, not re-sent ---------------------

  const pat = await makeContact(POISON_USER, "Pat Refused");
  await seedChunks(POISON_USER, pat, "cccccccc-3333-4333-8333-cccccccccccc", "An ordinary note about hiring.");
  await seedChunks(POISON_USER, pat, "dddddddd-4444-4444-8444-dddddddddddd", "POISON text the provider will not take.");
  let poisonCalls = 0;
  const refusing: typeof createEmbeddingsBatch = async (_userId, texts) => {
    if (texts.some((t) => t.includes("POISON"))) {
      poisonCalls++;
      throw new Error("Invalid input: content could not be embedded");
    }
    return texts.map(topicVector);
  };
  const poisoned = await runEmbeddingBackfill(POISON_USER, refusing);
  check("the good passage still embeds alongside a refused one", poisoned.passages === 1, JSON.stringify(poisoned));
  check("the refused passage is not counted as remaining work", poisoned.remaining === 0, JSON.stringify(poisoned));
  const marked = await db.query.embeddingFailures.findMany({
    where: and(eq(embeddingFailures.userId, POISON_USER), eq(embeddingFailures.sourceType, "memory_chunk")),
  });
  check("and it is recorded in embedding_failures", marked.length === 1, String(marked.length));
  poisonCalls = 0;
  await runEmbeddingBackfill(POISON_USER, refusing);
  check("a second pass does not send it to the provider again", poisonCalls === 0, String(poisonCalls));

  // --- an account that can never embed is not a backlog ---------------------------------------

  const kim = await makeContact(KEYLESS_USER, "Kim Keyless");
  await seedChunks(KEYLESS_USER, kim, "eeeeeeee-5555-4555-8555-eeeeeeeeeeee", "A note about fundraising.");
  check(
    "an account with no embeddings backend is recognised as such",
    (await accountCanEmbed(KEYLESS_USER)) === false
  );
  // The REAL provider seam this time — no injected `embed`. Before the gate this threw a
  // key-level error from the passage phase on every run.
  let threw: unknown = null;
  const keyless = await runEmbeddingBackfill(KEYLESS_USER).catch((err) => {
    threw = err;
    return null;
  });
  check("the drain does not throw for it", threw === null, String(threw));
  check(
    "and does not report its passages as remaining — they are not work that can be done",
    keyless?.remaining === 0,
    JSON.stringify(keyless)
  );
  const stillLexical = await searchMemories(KEYLESS_USER, { query: "fundraising" });
  check("its passages are still found by their words", stillLexical.length === 1, String(stillLexical.length));

  // --- the sweep runs even when every embedding phase throws ----------------------------------

  const sam = await makeContact(SWEEP_USER, "Sam Sweep");
  await db.insert(interactions).values({
    userId: SWEEP_USER,
    contactId: sam,
    interactionType: "note",
    rawNotes: "Imported history: talked about the Lisbon office.",
    interactionDate: new Date("2025-11-02T09:00:00Z"),
  });
  const keyLevel: typeof createEmbeddingsBatch = async () => {
    throw new Error("Anthropic has no embeddings API. Add an OpenAI or Gemini API key.");
  };
  const failed = await runEmbeddingBackfill(SWEEP_USER, keyLevel).catch((err) => err);
  check("a key-level error still surfaces from the drain", failed instanceof Error, String(failed));
  const swept = await searchMemories(SWEEP_USER, { query: "Lisbon office" });
  check(
    "but the history was cut into passages BEFORE it — findable by its words regardless",
    swept.length === 1,
    String(swept.length)
  );
  check(
    "and the passage is left pending, not marked failed, for when a key is added",
    (await pendingMemoryChunkCount(SWEEP_USER)) === 1
  );

  // --- the cron's user list: work that can be done, and none that cannot ---------------------

  // State now: KEYLESS has a passage it can never embed; SWEEP has one pending that it could
  // embed once a key exists; a fresh user has un-chunked history. `canEmbed` is stubbed so
  // the selector's filtering is what is under test, not this machine's keys.
  const HISTORY_USER = "smoke-memory-embedding-history";
  await db.delete(interactions).where(eq(interactions.userId, HISTORY_USER));
  await db.delete(contacts).where(eq(contacts.userId, HISTORY_USER));
  await ensureUserSettings(HISTORY_USER);
  const hal = await makeContact(HISTORY_USER, "Hal History");
  await db.insert(interactions).values({
    userId: HISTORY_USER,
    contactId: hal,
    interactionType: "note",
    rawNotes: "Old note from before passages existed.",
    interactionDate: new Date("2024-01-10T09:00:00Z"),
  });
  const canEmbedStub = async (u: string) => u !== KEYLESS_USER;
  const picked = await usersWithPendingMemoryWork(25, canEmbedStub);
  check(
    "the cron picks up an account whose only work is un-chunked history",
    picked.includes(HISTORY_USER),
    JSON.stringify(picked)
  );
  check(
    "and an account with passages it can embed",
    picked.includes(SWEEP_USER),
    JSON.stringify(picked)
  );
  check(
    "but not an account whose passages can never be embedded — it would starve the rest",
    !picked.includes(KEYLESS_USER),
    JSON.stringify(picked)
  );
  const capped = await usersWithPendingMemoryWork(1, canEmbedStub);
  check("the list honours its limit", capped.length <= 1, JSON.stringify(capped));

  for (const u of [USER, POISON_USER, KEYLESS_USER, SWEEP_USER, HISTORY_USER]) {
    await db.delete(embeddingFailures).where(eq(embeddingFailures.userId, u));
    await db.delete(memoryChunks).where(eq(memoryChunks.userId, u));
    await db.delete(interactions).where(eq(interactions.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll memory-embedding checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
