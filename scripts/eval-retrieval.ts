/**
 * Retrieval accuracy eval: recall@12 and recall@60 over fixture questions.
 * Without an AI key: lexical arms only. With a key (GEMINI_API_KEY or
 * OPENAI_API_KEY in env, local only): + semantic arm and rerank stage.
 * Stop dev servers on .data/pglite first (PGlite is single-writer).
 * Run: npx tsx scripts/eval-retrieval.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, contactEmbeddings, tags, contactTags } from "../src/db/schema";
import { hybridSearchContacts } from "../src/lib/hybrid-search";
import { rebuildContactEmbeddingsBatch } from "../src/lib/search";
import { getQueryEmbedding } from "../src/lib/embedding-cache";
import { rerankCandidates } from "../src/lib/chat-retrieval";

const U = "eval-retrieval-user";

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

  const hasKey = Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
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

  // Cleanup
  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, U));
  await db.delete(tags).where(eq(tags.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, U));
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
