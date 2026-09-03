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
    // "Engineer of Systems" gives Grace a lexical match on "engineer" without
    // giving her the fintech industry — she's the unfiltered-only match the
    // mixed recall-guard case (#5) needs.
    title: "Rear Admiral, Engineer of Systems", school: "Yale", industry: "defense", location: "Arlington",
  }).returning();
  const [alan] = await db.insert(contacts).values({
    userId: U, fullName: "Alan Turing", company: "Bletchley Park",
    title: "Cryptanalyst", school: "Cambridge", industry: "research", location: "London",
    notes: "Loves puzzles and long-distance running.",
    closenessTier: "inner",
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

  // 2a. Prefix-LIKE fuzzy arm: "ada" (3 chars) is a straight prefix of "Ada
  // Lovelace" — trigram similarity is active at this length too, but the
  // prefix-LIKE predicate alone already covers it.
  hits = await hybridSearchContacts(U, { query: "ada" });
  check("3-char prefix finds Ada", hits.some((h) => h.id === ada.id));

  // 2b. "ad" (2 chars) is below the trigram-similarity threshold (needs 3+),
  // so only the always-on prefix-LIKE predicate can surface Ada here.
  hits = await hybridSearchContacts(U, { query: "ad" });
  check("2-char prefix (below trigram threshold) still finds Ada", hits.some((h) => h.id === ada.id));

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

  // 5. Mixed recall-guard case: the industry filter matches exactly Ada, while
  // the unfiltered query "engineer" also lexically matches Grace (her title).
  // Filtered hits must lead with relevance 1 and filterMatched true; backfill
  // must trail, flagged filterMatched false, at a strictly lower relevance —
  // and the whole array must stay non-increasing.
  hits = await hybridSearchContacts(U, {
    query: "engineer", filters: { industries: ["fintech"] },
  });
  check("industry filter surfaces Ada as the filtered match", hits[0]?.id === ada.id);
  check("Ada is filterMatched", hits[0]?.filterMatched === true);
  check("Ada's relevance is 1", hits[0]?.relevance === 1);
  check(
    "only Ada carries filterMatched true",
    hits.filter((h) => h.filterMatched).every((h) => h.id === ada.id)
  );
  const graceBackfilled = hits.find((h) => h.id === grace.id);
  check(
    "Grace appears only as recall-guard backfill",
    graceBackfilled !== undefined && graceBackfilled.filterMatched === false
  );
  check(
    "backfilled relevance is strictly below the filtered relevance",
    graceBackfilled !== undefined && graceBackfilled.relevance < hits[0].relevance
  );
  check(
    "relevance is non-increasing across the merged array",
    hits.every((h, i) => i === 0 || h.relevance <= hits[i - 1].relevance)
  );

  // 6. Tag filter.
  hits = await hybridSearchContacts(U, { query: "hopper", filters: { tags: ["mentor"] } });
  check("tag filter keeps Grace", hits.length === 1 && hits[0].id === grace.id);
  check("tag-filtered Grace is filterMatched", hits[0]?.filterMatched === true);

  // 7. Recall guard: absurd filter falls back to unfiltered rather than empty.
  hits = await hybridSearchContacts(U, {
    query: "Hopper", filters: { companies: ["nonexistent-corp"] },
  });
  const graceRecallGuard = hits.find((h) => h.id === grace.id);
  check("recall guard returns unfiltered results", graceRecallGuard !== undefined);
  check(
    "recall-guard hit is flagged filterMatched false",
    graceRecallGuard?.filterMatched === false
  );

  // 8. relevance normalized into (0, 1].
  check("top relevance is 1", Math.abs(hits[0].relevance - 1) < 1e-9);

  // 9. closenessTiers filter: Alan is the only "inner" contact. "London" also
  // lexically matches Ada (unfiltered) via her location, so the same mixed
  // filtered/backfill shape as #5 applies here.
  hits = await hybridSearchContacts(U, {
    query: "London", filters: { closenessTiers: ["inner"] },
  });
  check("closeness-tier filter surfaces Alan as the filtered match", hits[0]?.id === alan.id);
  check("Alan is filterMatched", hits[0]?.filterMatched === true);
  check(
    "only Alan carries filterMatched true",
    hits.filter((h) => h.filterMatched).every((h) => h.id === alan.id)
  );

  // 10. Wildcard escaping: "A_B Corp" has a literal underscore. The filter
  // value "a_b" must match it literally rather than as a single-char
  // wildcard, and an unrelated value must not match at all. The recall guard
  // can still surface Wendy as backfill on the negative case (she's the only
  // lexical match for "wildcard" either way), so the assertion is on
  // filterMatched, not on presence in the result set.
  const [wendy] = await db.insert(contacts).values({
    userId: U, fullName: "Wendy Wildcard", company: "A_B Corp",
    title: "Analyst", industry: "other", location: "Remote",
  }).returning();

  hits = await hybridSearchContacts(U, {
    query: "wildcard", filters: { companies: ["a_b"] },
  });
  check(
    "literal underscore in company filter matches literally",
    hits.some((h) => h.id === wendy.id && h.filterMatched)
  );

  hits = await hybridSearchContacts(U, {
    query: "wildcard", filters: { companies: ["axb"] },
  });
  check(
    "underscore is not treated as a SQL wildcard",
    !hits.some((h) => h.id === wendy.id && h.filterMatched)
  );

  await cleanup(db);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
