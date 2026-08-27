/**
 * Integration test for hybridSearchContacts against local PGlite.
 * Seeds contacts + hand-written embedding vectors (no AI calls).
 *
 * pgvector is not available on local PGlite (see scripts/smoke-pgvector-local.ts), so the
 * semantic arm always takes the bounded JS-cosine fallback here — there is no
 * `embedding_vector` column locally, so this smoke never writes one. The jsonb `embedding`
 * values written by the plain inserts below are what the fallback reads, and the SQL
 * pgvector path in src/lib/hybrid-search.ts (exercised in prod on Neon) is left untouched.
 *
 * Stop dev servers on .data/pglite first.
 * Run: npx tsx scripts/smoke-hybrid-search.ts
 */
import { eq } from "drizzle-orm";
import { getDb, isPgvectorAvailable } from "../src/db";
import { contacts, contactEmbeddings, tags, contactTags } from "../src/db/schema";
import { hybridSearchContacts } from "../src/lib/hybrid-search";

const U = "smoke-hybrid-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

// Deterministic unit vector along one axis of an 8-dim space. cosineSimilarity compares
// raw arrays without padding, so an 8-dim query vector vs 8-dim stored vectors works
// directly through the JS fallback.
function axisVector(axis: number): number[] {
  const v = Array(8).fill(0);
  v[axis] = 1;
  return v;
}

async function cleanup(db: Awaited<ReturnType<typeof getDb>>) {
  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, U));
  await db.delete(tags).where(eq(tags.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, U));
}

async function main() {
  if (process.env.DATABASE_URL) throw new Error("Unset DATABASE_URL — local PGlite only.");
  const db = await getDb();
  // Local PGlite has no pgvector extension (Task 1 assumption was wrong; controller ruling).
  // The semantic arm below is exercised entirely through the JS-cosine fallback.
  check("pgvector NOT available locally (semantic arm uses JS fallback)", isPgvectorAvailable() === false);
  await cleanup(db);

  const [ada] = await db.insert(contacts).values({
    userId: U, fullName: "Ada Lovelace", company: "Analytical Engines",
    title: "Engineer", school: "Somerville", industry: "fintech", location: "London",
  }).returning();
  const [grace] = await db.insert(contacts).values({
    userId: U, fullName: "Grace Hopper", company: "Navy Research",
    title: "Rear Admiral", school: "Yale", industry: "defense", location: "Arlington",
  }).returning();
  const [alan] = await db.insert(contacts).values({
    userId: U, fullName: "Alan Turing", company: "Bletchley Park",
    title: "Cryptanalyst", school: "Cambridge", industry: "research", location: "London",
    notes: "Loves puzzles and long-distance running.",
  }).returning();

  const [tagRow] = await db.insert(tags).values({ userId: U, name: "mentor" }).returning();
  await db.insert(contactTags).values({ contactId: grace.id, tagId: tagRow.id });

  // Hand-written vectors: ada -> axis 0, grace -> axis 1, alan -> axis 2.
  for (const [contact, axis] of [[ada, 0], [grace, 1], [alan, 2]] as const) {
    await db.insert(contactEmbeddings).values({
      userId: U, contactId: contact.id, sourceType: "profile", sourceId: contact.id,
      embedding: axisVector(axis), content: contact.fullName,
    });
  }

  // 1. FTS arm: exact name token.
  let hits = await hybridSearchContacts(U, { query: "Hopper" });
  check("fts finds Grace", hits[0]?.id === grace.id);
  check("matchedArms includes fts", hits[0]?.matchedArms.includes("fts") === true);

  // 2. Trigram arm: typo'd name.
  hits = await hybridSearchContacts(U, { query: "Ada Lovelase" });
  check("typo finds Ada", hits.some((h) => h.id === ada.id));

  // 3. Semantic arm: query embedding on Alan's axis, lexically unrelated text.
  hits = await hybridSearchContacts(U, {
    query: "zzqx unrelated", embedding: axisVector(2),
  });
  check("semantic finds Alan", hits.some((h) => h.id === alan.id));
  check(
    "semantic hit tagged",
    hits.find((h) => h.id === alan.id)!.matchedArms.includes("semantic")
  );

  // 4. Fusion: lexical Grace + semantic-on-Ada — both present, Grace not starved.
  hits = await hybridSearchContacts(U, { query: "Hopper", embedding: axisVector(0) });
  const ids = hits.map((h) => h.id);
  check("fusion keeps both arms' hits", ids.includes(grace.id) && ids.includes(ada.id));

  // 5. Filters: industry narrows to Ada.
  hits = await hybridSearchContacts(U, {
    query: "engineer", filters: { industries: ["fintech"] },
  });
  check("industry filter keeps Ada only", hits.length >= 1 && hits.every((h) => h.id === ada.id));

  // 6. Tag filter.
  hits = await hybridSearchContacts(U, { query: "hopper", filters: { tags: ["mentor"] } });
  check("tag filter keeps Grace", hits.length === 1 && hits[0].id === grace.id);

  // 7. Recall guard: absurd filter falls back to unfiltered rather than empty.
  hits = await hybridSearchContacts(U, {
    query: "Hopper", filters: { companies: ["nonexistent-corp"] },
  });
  check("recall guard returns unfiltered results", hits.some((h) => h.id === grace.id));

  // 8. relevance normalized into (0, 1].
  check("top relevance is 1", Math.abs(hits[0].relevance - 1) < 1e-9);

  await cleanup(db);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
