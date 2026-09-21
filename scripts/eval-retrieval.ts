/**
 * Retrieval accuracy eval: recall@12 and recall@60 over fixture questions.
 * Without an AI key: lexical arms only. With a key (GEMINI_API_KEY or
 * OPENAI_API_KEY in env, local only — the local stand-ins for Orbit's managed keys, used
 * via a Lifetime comp on the eval user): + semantic arm and rerank stage.
 * Runs on a throwaway PGlite directory unless ORBIT_PGLITE_DIR is set, so it never
 * contends with a dev server's .data/pglite (PGlite is single-writer).
 *
 * A gate, not just a report: exits 1 when recall falls under the floor. Lexical-only runs
 * default to the floor measured on Sep 19 2026 (19/24 = 79.2%); with a key, pass the
 * floor from your own baseline run: --min-recall12 0.9 --min-recall60 0.95.
 * Run: npx tsx scripts/eval-retrieval.ts [--min-recall12 R] [--min-recall60 R]
 *
 * PASSAGES (second section). The same harness then seeds notes from
 * `passage-search-eval.json`, indexes them through the real sweep (`backfillMemoryChunks`),
 * and scores `searchMemories`: recall@8 and MRR over buried-fact, no-person, date- and
 * person-scoped questions, plus `forbidHits` — a scoped question that returns a note its
 * date or person should have excluded. Those are gated. `paraphrase` cases share no word
 * with their note on purpose, so they are REPORTED, not gated, without a key: they measure
 * what the semantic arm buys. With a key the passages are embedded through the real drain
 * and `--min-paraphrase R` gates them too.
 */
import { config } from "dotenv";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
config({ path: ".env.local" });
config();
if (!process.env.ORBIT_PGLITE_DIR) {
  process.env.ORBIT_PGLITE_DIR = mkdtempSync(path.join(tmpdir(), "orbit-eval-retrieval-"));
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, contactEmbeddings, tags, contactTags, interactions, memoryChunks } from "../src/db/schema";
import { loadPassageFixture, seedPassageNotes } from "./lib/eval-passage-notes";
import { searchMemories } from "../src/lib/memory-search";
import { runEmbeddingBackfill } from "../src/lib/embedding-backfill";
import { hybridSearchContacts } from "../src/lib/hybrid-search";
import { rebuildContactEmbeddingsBatch } from "../src/lib/search";
import { getQueryEmbedding } from "../src/lib/embedding-cache";
import { rerankCandidates } from "../src/lib/chat-retrieval";
import { managedKeysConfigured } from "../src/lib/ai-access";
import { setCompedPlan } from "../src/lib/user-settings";

const U = "eval-retrieval-user";

/** Lexical-only recall measured on Sep 19 2026: 19 of the 24 expected contacts. */
const LEXICAL_FLOOR = 19 / 24;

/**
 * Lexical-only passage floors, measured on Sep 21 2026 when this section was added: 10/10
 * gated passages found, MRR 0.944, no forbidden hits. Recall is held exactly. MRR is held a
 * little under what was measured because `ts_rank_cd` ties have no guaranteed order, so one
 * swap between two equally-ranked passages must not read as a regression.
 *
 * Note what recall alone does NOT catch: with date scoping deleted outright, recall stayed at
 * 100% — the right March note was still found, just alongside the June one. Only the
 * forbidden-hit check failed. That check is the one that matters for scoped questions.
 */
const PASSAGE_LEXICAL_RECALL_FLOOR = 10 / 10;
const PASSAGE_LEXICAL_MRR_FLOOR = 0.9;
/** How many passages a case may look at. Matches `searchMemories`' default limit. */
const PASSAGE_K = 8;

type Fixture = {
  contacts: Array<{
    email: string; fullName: string; company: string; title: string; school: string;
    industry: string; location: string; notes: string; tags: string[];
  }>;
  cases: Array<{ question: string; expect: string[]; kind: string }>;
};

async function main() {
  if (process.env.DATABASE_URL) throw new Error("Unset DATABASE_URL — local PGlite only.");
  const fixture: Fixture = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "scripts", "eval-fixtures", "contact-search-eval.json"),
      "utf8"
    )
  );
  const db = await getDb();

  // Clean + seed
  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, U));
  await db.delete(tags).where(eq(tags.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, U));

  const idByEmail = new Map<string, string>();
  for (const c of fixture.contacts) {
    const [row] = await db.insert(contacts).values({
      userId: U, fullName: c.fullName, company: c.company, title: c.title,
      school: c.school, industry: c.industry, location: c.location,
      notes: c.notes, email: c.email,
    }).returning();
    idByEmail.set(c.email, row.id);
    for (const tagName of c.tags) {
      let tagRow = await db.query.tags.findFirst({
        where: and(eq(tags.userId, U), eq(tags.name, tagName)),
      });
      if (!tagRow) {
        [tagRow] = await db.insert(tags).values({ userId: U, name: tagName }).returning();
      }
      await db.insert(contactTags).values({ contactId: row.id, tagId: tagRow.id });
    }
  }

  // The eval user runs AI through the gate like everyone else. Off Vercel the local
  // GEMINI_API_KEY / OPENAI_API_KEY act as Orbit's managed keys, which only a Lifetime
  // account may use — so the harness comps its synthetic user to Lifetime rather than
  // reaching around the gate for a key.
  const configured = managedKeysConfigured();
  const hasKey = configured.gemini || configured.openai;
  if (hasKey) await setCompedPlan(U, "lifetime", { note: "eval-retrieval harness" });
  if (hasKey) {
    console.log("AI key detected: building embeddings + running semantic arm & rerank.");
    await rebuildContactEmbeddingsBatch(U, [...idByEmail.values()]);
  } else {
    console.log("No AI key: lexical arms only (fts + trigram).");
  }

  let hit12 = 0, hit60 = 0, expectedTotal = 0;
  const failures: string[] = [];

  for (const evalCase of fixture.cases) {
    const embedding = hasKey
      ? await getQueryEmbedding(U, evalCase.question).catch(() => null)
      : null;
    const wide = await hybridSearchContacts(U, {
      query: evalCase.question, embedding, limit: 60,
    });
    const top = hasKey ? await rerankCandidates(U, evalCase.question, wide) : wide.slice(0, 12);

    const wideIds = new Set(wide.map((c) => c.id));
    const topIds = new Set(top.slice(0, 12).map((c) => c.id));
    const expectedIds = evalCase.expect.map((e) => idByEmail.get(e)!);

    expectedTotal += expectedIds.length;
    const in12 = expectedIds.filter((id) => topIds.has(id)).length;
    const in60 = expectedIds.filter((id) => wideIds.has(id)).length;
    hit12 += in12;
    hit60 += in60;
    const mark = in12 === expectedIds.length ? "PASS" : in60 === expectedIds.length ? "wide" : "MISS";
    console.log(`  [${mark}] (${evalCase.kind}) "${evalCase.question}" — ${in12}/${expectedIds.length} @12, ${in60}/${expectedIds.length} @60`);
    if (mark === "MISS") failures.push(evalCase.question);
  }

  console.log("");
  console.log(`recall@12: ${(hit12 / expectedTotal * 100).toFixed(1)}%  (${hit12}/${expectedTotal})`);
  console.log(`recall@60: ${(hit60 / expectedTotal * 100).toFixed(1)}%  (${hit60}/${expectedTotal})`);
  if (failures.length) console.log(`misses: ${failures.join(" | ")}`);

  const arg = (flag: string) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? Number(process.argv[i + 1]) : null;
  };
  // Without a key only the lexical arms run, and their floor is known; with one, the floor
  // is whatever your baseline measured, so it has to be passed in.
  const floor12 = arg("--min-recall12") ?? (hasKey ? null : LEXICAL_FLOOR);
  const floor60 = arg("--min-recall60") ?? (hasKey ? null : LEXICAL_FLOOR);
  const r12 = hit12 / expectedTotal;
  const r60 = hit60 / expectedTotal;
  const below: string[] = [];
  if (floor12 != null && r12 < floor12 - 1e-9) below.push(`recall@12 ${r12.toFixed(3)} < ${floor12}`);
  if (floor60 != null && r60 < floor60 - 1e-9) below.push(`recall@60 ${r60.toFixed(3)} < ${floor60}`);

  // ------------------------------------------------------------------ passages -----------
  const passages = loadPassageFixture(path.join(process.cwd(), "scripts", "eval-fixtures"));
  await db.delete(memoryChunks).where(eq(memoryChunks.userId, U));
  await db.delete(interactions).where(eq(interactions.userId, U));

  // Seeded and indexed through the same path the research eval uses — see
  // `scripts/lib/eval-passage-notes.ts`.
  const noteIdBySource = await seedPassageNotes(
    U,
    passages,
    new Map([...idByEmail].map(([email, id]) => [email, id]))
  );
  if (hasKey) {
    // And embedded through the real drain, with the real provider.
    const drained = await runEmbeddingBackfill(U);
    console.log(`\nPassages embedded: ${drained.passages} (remaining ${drained.remaining}).`);
  }

  console.log(`\nPassages — ${hasKey ? "lexical + semantic" : "lexical only"}:`);
  let pHit = 0, pExpected = 0, rrSum = 0, rrCases = 0, forbidHits = 0;
  let paraHit = 0, paraExpected = 0;
  for (const c of passages.cases) {
    const embedding = hasKey ? await getQueryEmbedding(U, c.question).catch(() => null) : null;
    const results = await searchMemories(U, {
      query: c.question,
      embedding,
      after: c.after ? new Date(`${c.after}T00:00:00Z`) : null,
      before: c.before ? new Date(`${c.before}T23:59:59Z`) : null,
      contactIds: c.person ? [idByEmail.get(c.person)!] : null,
      limit: PASSAGE_K,
    });
    // Several chunks of one note can rank separately; a note counts at its best rank.
    const ranked: string[] = [];
    for (const r of results) {
      const id = noteIdBySource.get(r.sourceId);
      if (id && !ranked.includes(id)) ranked.push(id);
    }
    const found = c.expect.filter((id) => ranked.includes(id)).length;
    const forbidden = (c.forbid ?? []).filter((id) => ranked.includes(id));
    const firstRank = ranked.findIndex((id) => c.expect.includes(id));
    const paraphrase = c.kind === "paraphrase";
    if (paraphrase) {
      paraHit += found;
      paraExpected += c.expect.length;
    } else {
      pHit += found;
      pExpected += c.expect.length;
      rrSum += firstRank >= 0 ? 1 / (firstRank + 1) : 0;
      rrCases += 1;
      forbidHits += forbidden.length;
    }
    const mark = forbidden.length
      ? "LEAK"
      : found === c.expect.length
        ? "PASS"
        : paraphrase ? "miss" : "MISS";
    console.log(
      `  [${mark}] (${c.kind}) "${c.question}" — ${found}/${c.expect.length} @${PASSAGE_K}` +
        (firstRank >= 0 ? `, first at ${firstRank + 1}` : "") +
        (forbidden.length ? `, returned excluded ${forbidden.join(",")}` : "")
    );
  }
  const pRecall = pExpected ? pHit / pExpected : 0;
  const pMrr = rrCases ? rrSum / rrCases : 0;
  const paraRecall = paraExpected ? paraHit / paraExpected : 0;
  console.log("");
  console.log(`passage recall@${PASSAGE_K}: ${(pRecall * 100).toFixed(1)}%  (${pHit}/${pExpected})`);
  console.log(`passage MRR:        ${pMrr.toFixed(3)}`);
  console.log(`forbidden hits:     ${forbidHits}`);
  console.log(`paraphrase recall@${PASSAGE_K}: ${(paraRecall * 100).toFixed(1)}%  (${paraHit}/${paraExpected})${hasKey ? "" : " — reported, not gated: no embeddings without a key"}`);

  const pFloor = arg("--min-passage-recall") ?? (hasKey ? null : PASSAGE_LEXICAL_RECALL_FLOOR);
  const mrrFloor = arg("--min-passage-mrr") ?? (hasKey ? null : PASSAGE_LEXICAL_MRR_FLOOR);
  const paraFloor = arg("--min-paraphrase");
  if (pFloor != null && pRecall < pFloor - 1e-9) below.push(`passage recall ${pRecall.toFixed(3)} < ${pFloor}`);
  if (mrrFloor != null && pMrr < mrrFloor - 1e-9) below.push(`passage MRR ${pMrr.toFixed(3)} < ${mrrFloor}`);
  if (paraFloor != null && paraRecall < paraFloor - 1e-9) below.push(`paraphrase recall ${paraRecall.toFixed(3)} < ${paraFloor}`);
  // Never allowed, with or without a key: a scoped question that returns what its scope
  // excludes is a wrong answer, not a weak one.
  if (forbidHits > 0) below.push(`${forbidHits} forbidden passage(s) returned`);

  await db.delete(memoryChunks).where(eq(memoryChunks.userId, U));
  await db.delete(interactions).where(eq(interactions.userId, U));

  // Cleanup
  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, U));
  await db.delete(tags).where(eq(tags.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, U));

  if (below.length) {
    console.log(`\nGATE: FAIL — ${below.join("; ")}`);
    process.exit(1);
  }
  console.log("\nGATE: PASS");
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
