# Contact Search Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Orbit's full-table-scan contact search with a unified SQL-side hybrid retrieval core, and upgrade LLM chat to an accuracy-first pipeline (query understanding → wide retrieval → LLM rerank → budgeted answer).

**Architecture:** A new `hybridSearchContacts()` runs three retrieval arms (weighted full-text, trigram fuzzy, pgvector ANN) as parallel bounded SQL queries, fuses them with reciprocal-rank fusion in JS, and hydrates one page of contacts. Chat, ask-bar, and graph search all call it. Chat adds two flash-tier LLM stages (query parsing, candidate reranking) that degrade to pass-through on any failure. Upload-time embedding writes gain content-hash skips and batched statements.

**Tech Stack:** Next.js App Router, Drizzle ORM (neon-http prod / PGlite dev), pgvector + pg_trgm, raw vendor AI SDKs (`@anthropic-ai/sdk`, `@google/genai`, `openai`) via `completeJson`, tsx smoke scripts (no test framework).

**Spec:** `docs/superpowers/specs/2026-08-26-contact-search-optimization-design.md`

## Global Constraints

- **Worktree node_modules:** this worktree may have no `node_modules`; if missing, symlink the main checkout's (`ln -s /Users/jasonpereira/Projects/orbit/node_modules node_modules`) or `tsc`/`eslint` silently no-op and exit 0. Verify `npx tsc --version` prints a version before trusting any check.
- **PGlite single-writer:** never run a DB-touching script while a dev server is running against the same `.data/pglite` — overlapping writers corrupt it unrecoverably. Stop the dev server first.
- **Test convention:** no vitest/jest. Tests are `scripts/smoke-*.ts` run via `npx tsx`, using a local `check(label, condition)` helper that throws on failure, and MUST end with explicit `process.exit(0)` (tsx scripts otherwise hang on open DB handles).
- **`"use server"` files** may export only async functions; one non-async export kills every export and tsc can't see it.
- **Never import `next/server`** (or anything that reaches it) into low-level `src/lib` modules.
- **Client bundles must never reach `@/db`:** every new module in this plan is server-only; do not import them from client components.
- **DDL changes** go in `src/db/index.ts` (SCALE_DDL / applyScaleSchema / migrate fns), never `drizzle-kit push` (drops the runtime-managed `embedding_vector` column). Each task that changes DDL bumps `SCHEMA_VERSION` (`src/db/index.ts:590`) by exactly 1, or the sweep is skipped on DBs that already recorded the old version.
- **Baselines:** build passes; eslint baseline is 48 errors (do not exceed); `npx tsc --noEmit` must stay clean.
- **Embedding vectors** are padded/truncated to 1536 dims only at `formatVectorLiteral` (`src/lib/pgvector.ts`); jsonb `embedding` stores the raw provider output.
- **Verbatim vocab:** closeness tiers are exactly `"inner" | "mid" | "outer"`. Fast models per provider: gemini `gemini-3.1-flash-lite`, openai `gpt-4o-mini`, anthropic `claude-haiku-4-5`.

---

### Task 1: PGlite pgvector parity

Local dev currently always takes the JS cosine fallback because pgvector was believed to have no PGlite build. It does: `@electric-sql/pglite` ≥0.2 ships a `vector` extension bundle. Wire it in so dev exercises the same ANN SQL as prod.

**Files:**
- Modify: `src/db/index.ts` (PGlite construction ~line 1399-1414; `migratePgvector` ~1217-1231; `migratePglite` ~869; `SCHEMA_VERSION` line 590; stale comment ~1402-1406)
- Modify: `src/lib/search.ts:220-223` (stale comment only)
- Test: `scripts/smoke-pgvector-local.ts`

**Interfaces:**
- Consumes: existing `globalForDb`, `StatementRunner`, `detectExtensions`.
- Produces: `isPgvectorAvailable()` returns `true` on local PGlite; `contact_embeddings.embedding_vector` + `embeddings_vector_hnsw_idx` exist locally. New exported helper `migratePgvectorShared(run: StatementRunner): Promise<void>` (internal to db/index.ts, not exported — later tasks rely only on `isPgvectorAvailable()`).

- [ ] **Step 1: Verify toolchain** — run `npx tsc --version` from the worktree root. If it errors, symlink node_modules per Global Constraints.

- [ ] **Step 2: Write the failing smoke test**

Create `scripts/smoke-pgvector-local.ts`:

```ts
/**
 * Asserts local PGlite has the pgvector extension: embedding_vector column, HNSW index,
 * and a working `<=>` operator. Stop any dev server using .data/pglite before running.
 * Run: npx tsx scripts/smoke-pgvector-local.ts
 */
import { getDb, isPgvectorAvailable, rowsOf } from "../src/db";
import { sql } from "drizzle-orm";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  if (process.env.DATABASE_URL) {
    throw new Error("Unset DATABASE_URL — this smoke targets local PGlite.");
  }
  const db = await getDb();
  check("isPgvectorAvailable() is true locally", isPgvectorAvailable());

  const ext = rowsOf<{ extname: string }>(
    await db.execute(sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`)
  );
  check("vector extension installed", ext.length === 1);

  const col = rowsOf<{ column_name: string }>(
    await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'contact_embeddings' AND column_name = 'embedding_vector'`)
  );
  check("embedding_vector column exists", col.length === 1);

  const idx = rowsOf<{ indexname: string }>(
    await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'contact_embeddings' AND indexname = 'embeddings_vector_hnsw_idx'`)
  );
  check("HNSW index exists", idx.length === 1);

  const dist = rowsOf<{ d: number }>(
    await db.execute(sql`SELECT ('[1,0,0]'::vector(3) <=> '[0,1,0]'::vector(3))::float8 AS d`)
  );
  check("<=> operator works", Math.abs(Number(dist[0]?.d) - 1) < 1e-6);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx tsx scripts/smoke-pgvector-local.ts`
Expected: FAIL at "isPgvectorAvailable() is true locally" (pgvector not wired into PGlite yet).

- [ ] **Step 4: Wire the vector extension into PGlite**

In `src/db/index.ts`, next to the existing `pg_trgm` import (search for `from "@electric-sql/pglite/contrib/pg_trgm"`), add:

```ts
import { vector } from "@electric-sql/pglite/vector";
```

In `ensureReady()` (~line 1407), add `vector` to the extension bundle:

```ts
globalForDb.orbitPglite = await PGlite.create({
  dataDir,
  extensions: { pg_trgm, vector },
});
```

Update the comment directly above it: pgvector DOES have a PGlite build; the bundle is supplied at construction and `CREATE EXTENSION` activates it.

- [ ] **Step 5: Make the pgvector migration driver-agnostic**

`migratePgvector` currently takes the Neon client. Replace it with a `StatementRunner` version and call it from both paths. In `src/db/index.ts`:

```ts
async function migratePgvector(run: StatementRunner) {
  try {
    await run(`CREATE EXTENSION IF NOT EXISTS vector`);
    await run(
      `ALTER TABLE contact_embeddings ADD COLUMN IF NOT EXISTS embedding_vector vector(1536)`
    );
    await run(
      `CREATE INDEX IF NOT EXISTS embeddings_vector_hnsw_idx
       ON contact_embeddings USING hnsw (embedding_vector vector_cosine_ops)`
    );
    globalForDb.orbitPgvector = true;
  } catch {
    globalForDb.orbitPgvector = false;
  }
}
```

At the existing call site in `migrateNeon`'s caller (~line 1384, `await migratePgvector(sql)`), change to `await migratePgvector((statement) => sql.query(statement))`.

At the end of `migratePglite(client)` (after its `ensureColumn` calls and before it returns), add:

```ts
await migratePgvector((statement) => client.query(statement));
```

Note `migratePglite` also runs `applyScaleSchema` — check where that happens for the PGlite path (search for `applyScaleSchema` call sites) and place `migratePgvector` adjacent so both drivers end up with identical runtime DDL.

- [ ] **Step 6: Bump SCHEMA_VERSION**

`src/db/index.ts:590`: `export const SCHEMA_VERSION = 7;` — existing local DBs recorded 6, so the sweep (including the new extension/column/index) re-runs once. `detectExtensions` already reads `pg_extension` on version-current boots, so no change needed there.

- [ ] **Step 7: Fix the stale comment in search.ts**

`src/lib/search.ts:220-223` — the fallback comment says PGlite "has no build of it". Reword to: the fallback covers DBs where the vector extension failed to install (and older PGlite data dirs until their next schema sweep).

- [ ] **Step 8: Run the smoke test to verify it passes**

Stop any dev server on this worktree's `.data/pglite` first. Run: `npx tsx scripts/smoke-pgvector-local.ts`
Expected: PASS, all 5 checks.

- [ ] **Step 9: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/db/index.ts src/lib/search.ts scripts/smoke-pgvector-local.ts
git commit -m "feat: enable pgvector in local PGlite for dev/prod search parity"
```

---

### Task 2: Fix the dead trigram index + contact-list typo tolerance

The trigram index is on `full_name`/`company` but every predicate wraps the column in `lower()`, so the planner never uses it. Recreate it on the lowered expressions and add a real fuzzy branch to the contact-list search.

**Files:**
- Modify: `src/db/index.ts` (`applyScaleSchema` ~line 740-756; `SCHEMA_VERSION`)
- Modify: `src/actions/contacts.ts:284-297` (`searchCondition`)
- Test: `scripts/smoke-trigram-search.ts`

**Interfaces:**
- Consumes: `pg_trgm` extension (already bundled), `getDb`, `rowsOf`.
- Produces: exported `isTrigramAvailable(): boolean` from `src/db/index.ts` (Task 4 uses it); index `contacts_name_trgm` now on `lower(full_name)`/`lower(company)`; `searchCondition` matches typos.

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/smoke-trigram-search.ts`:

```ts
/**
 * Asserts the trigram index matches the lower()-wrapped predicates and that a typo'd
 * name still matches via the % operator. Stop dev servers on .data/pglite first.
 * Run: npx tsx scripts/smoke-trigram-search.ts
 */
import { getDb, isTrigramAvailable, rowsOf } from "../src/db";
import { contacts } from "../src/db/schema";
import { sql, eq } from "drizzle-orm";

const EVAL_USER = "smoke-trigram-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  if (process.env.DATABASE_URL) throw new Error("Unset DATABASE_URL — local PGlite only.");
  const db = await getDb();
  check("isTrigramAvailable() is true", isTrigramAvailable());

  const idx = rowsOf<{ indexdef: string }>(
    await db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'contacts' AND indexname = 'contacts_name_trgm'`)
  );
  check("contacts_name_trgm exists", idx.length === 1);
  check(
    "index is on lower() expressions",
    /lower\(/.test(idx[0].indexdef),
    idx[0]?.indexdef
  );

  await db.delete(contacts).where(eq(contacts.userId, EVAL_USER));
  await db.insert(contacts).values({
    userId: EVAL_USER,
    fullName: "Katherine Mannington",
    company: "Braddock Capital",
  });

  // typo: "Katherin Manington"
  const hit = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT id FROM contacts
      WHERE user_id = ${EVAL_USER}
        AND (lower(full_name) % ${"katherin manington"} OR lower(coalesce(company, '')) % ${"katherin manington"})`)
  );
  check("typo'd name matches via % operator", hit.length === 1);

  await db.delete(contacts).where(eq(contacts.userId, EVAL_USER));
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/smoke-trigram-search.ts`
Expected: FAIL — `isTrigramAvailable` is not exported yet (tsx compile error). That is the failing state.

- [ ] **Step 3: Recreate the index and export the helper**

In `src/db/index.ts`, inside `applyScaleSchema`'s pg_trgm try-block (~747-753), replace the index creation with:

```ts
try {
  await run(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  // The predicates in searchCondition and the hybrid search arms compare
  // lower(column), so the index must be on the identical expression or the
  // planner ignores it. The old contacts_name_trgm on the raw columns was
  // never usable; drop it on the way through.
  await run(`DROP INDEX IF EXISTS contacts_name_trgm`);
  await run(
    `CREATE INDEX IF NOT EXISTS contacts_name_trgm
     ON contacts USING gin(lower(full_name) gin_trgm_ops, lower(coalesce(company, '')) gin_trgm_ops)`
  );
  globalForDb.orbitTrigram = true;
} catch {
  globalForDb.orbitTrigram = false;
}
```

Next to `isPgvectorAvailable` (~line 1162), add:

```ts
export function isTrigramAvailable() {
  return Boolean(globalForDb.orbitTrigram);
}
```

Bump `SCHEMA_VERSION` to `8`.

- [ ] **Step 4: Add the fuzzy branch to searchCondition**

In `src/actions/contacts.ts`, replace `searchCondition` with:

```ts
function searchCondition(q: string) {
  const like = `${q.toLowerCase()}%`;
  const lowered = q.toLowerCase();
  // Trigram similarity only helps (and only uses its index) for queries long
  // enough to produce meaningful trigrams; short prefixes are served by LIKE.
  const fuzzy =
    lowered.length >= 4
      ? sql` or lower(${contacts.fullName}) % ${lowered} or lower(coalesce(${contacts.company}, '')) % ${lowered}`
      : sql``;
  return sql`(
    contacts.search_tsv @@ websearch_to_tsquery('simple', ${q})
    or lower(${contacts.fullName}) like ${like}
    or lower(coalesce(${contacts.company}, '')) like ${like}
    or lower(coalesce(${contacts.email}, '')) like ${like}
    ${fuzzy}
    or exists (
      select 1 from contact_tags ct
      join tags t on t.id = ct.tag_id
      where ct.contact_id = ${contacts.id} and lower(t.name) like ${like}
    )
  )`;
}
```

Also update the doc comment above it (~269-278): the trigram branch now genuinely exists and is index-backed.

- [ ] **Step 5: Run the smoke test to verify it passes**

Run: `npx tsx scripts/smoke-trigram-search.ts`
Expected: PASS, all 4 checks. (The version bump re-runs the sweep, dropping and recreating the index.)

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/db/index.ts src/actions/contacts.ts scripts/smoke-trigram-search.ts
git commit -m "fix: trigram index on lower() expressions + typo tolerance in contact list search"
```

---

### Task 3: Query-embedding cache

An in-memory LRU so repeated/incremental queries skip the external embedding API round trip.

**Files:**
- Create: `src/lib/embedding-cache.ts`
- Test: `scripts/smoke-embedding-cache.ts`

**Interfaces:**
- Consumes: `createEmbedding(userId, text)` from `@/lib/ai` (as default embed fn).
- Produces: `getQueryEmbedding(userId: string, query: string, embed?: (userId: string, text: string) => Promise<number[]>): Promise<number[]>` and `normalizeQuery(q: string): string`. Tasks 5 and 10 call `getQueryEmbedding`.

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/smoke-embedding-cache.ts`:

```ts
/**
 * Exercises the query-embedding LRU: hit, miss, normalization, TTL, eviction.
 * No DB, no network. Run: npx tsx scripts/smoke-embedding-cache.ts
 */
import {
  getQueryEmbedding,
  normalizeQuery,
  __clearEmbeddingCacheForTests,
} from "../src/lib/embedding-cache";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  __clearEmbeddingCacheForTests();
  let calls = 0;
  const stub = async (_userId: string, text: string) => {
    calls += 1;
    return [text.length, calls, 0];
  };

  check("normalize collapses whitespace + case", normalizeQuery("  Who   KNOWS ai ") === "who knows ai");

  const a = await getQueryEmbedding("u1", "who knows AI", stub);
  const b = await getQueryEmbedding("u1", "  who knows ai ", stub);
  check("second call served from cache", calls === 1);
  check("cached value identical", a === b);

  await getQueryEmbedding("u2", "who knows AI", stub);
  check("different user is a different key", calls === 2);

  await getQueryEmbedding("u1", "different query", stub);
  check("different query misses", calls === 3);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/smoke-embedding-cache.ts`
Expected: FAIL — module `src/lib/embedding-cache.ts` does not exist.

- [ ] **Step 3: Implement the cache**

Create `src/lib/embedding-cache.ts`:

```ts
import { createHash } from "node:crypto";
import { createEmbedding } from "@/lib/ai";

/**
 * In-memory LRU for query embeddings. Fluid Compute reuses function instances
 * across requests, so a module-level cache gets a real hit rate: incremental
 * ask-bar typing and repeated chat phrasings skip the external embedding call.
 * Values are per-user (embedding backend is resolved from user settings).
 */
type Entry = { value: number[]; expiresAt: number };

const MAX_ENTRIES = 500;
const TTL_MS = 60 * 60 * 1000;

const globalForCache = globalThis as unknown as {
  orbitQueryEmbeddingCache?: Map<string, Entry>;
};

function cache(): Map<string, Entry> {
  if (!globalForCache.orbitQueryEmbeddingCache) {
    globalForCache.orbitQueryEmbeddingCache = new Map();
  }
  return globalForCache.orbitQueryEmbeddingCache;
}

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function cacheKey(userId: string, query: string): string {
  return createHash("sha256")
    .update(`${userId}\n${normalizeQuery(query)}`)
    .digest("hex");
}

export async function getQueryEmbedding(
  userId: string,
  query: string,
  embed: (userId: string, text: string) => Promise<number[]> = createEmbedding
): Promise<number[]> {
  const key = cacheKey(userId, query);
  const store = cache();
  const now = Date.now();

  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    // Re-insert to refresh LRU position (Map preserves insertion order).
    store.delete(key);
    store.set(key, hit);
    return hit.value;
  }
  if (hit) store.delete(key);

  const value = await embed(userId, query);
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, expiresAt: now + TTL_MS });
  return value;
}

export function __clearEmbeddingCacheForTests() {
  cache().clear();
}
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `npx tsx scripts/smoke-embedding-cache.ts`
Expected: PASS, all 5 checks.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/embedding-cache.ts scripts/smoke-embedding-cache.ts
git commit -m "feat: in-memory LRU cache for query embeddings"
```

---

### Task 4: Hybrid search core

The heart of the revision: three bounded SQL arms run in parallel, RRF fusion in JS, one hydration query. No full-table loads anywhere.

**Files:**
- Create: `src/lib/hybrid-search.ts`
- Test: `scripts/smoke-hybrid-search.ts`

**Interfaces:**
- Consumes: `getDb`, `rowsOf`, `isPgvectorAvailable`, `isTrigramAvailable` from `@/db`; `contacts`, `contactEmbeddings` from `@/db/schema`; `formatVectorLiteral` from `@/lib/pgvector`; `cosineSimilarity` from `@/lib/ai`.
- Produces (Tasks 5, 10, 11 depend on these exact shapes):

```ts
export type SearchFilters = {
  companies?: string[];
  industries?: string[];
  schools?: string[];
  locations?: string[];
  tags?: string[];
  closenessTiers?: Array<"inner" | "mid" | "outer">;
};

export type HybridSearchOptions = {
  query: string;
  embedding?: number[] | null;
  filters?: SearchFilters | null;
  expansionTerms?: string[];
  limit?: number; // default 12, clamped 1..80
};

export type RankedContact = {
  id: string;
  fullName: string;
  preferredName: string | null;
  company: string | null;
  school: string | null;
  title: string | null;
  location: string | null;
  email: string | null;
  industry: string | null;
  notes: string | null;
  aiSummary: string | null;
  keyFacts: string[];
  relationshipScore: number;
  priorityLevel: number;
  closenessTier: string | null;
  tags: string[];
  rrfScore: number;
  relevance: number;       // rrfScore / max(rrfScore) in this result set, in (0, 1]
  matchedArms: Array<"fts" | "trigram" | "semantic">;
};

export async function hybridSearchContacts(
  userId: string,
  options: HybridSearchOptions
): Promise<RankedContact[]>;
```

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/smoke-hybrid-search.ts`. It seeds a small network for a dedicated user, embeds nothing (semantic arm exercised with hand-made vectors written directly), and asserts each arm plus fusion, filters, and the recall guard:

```ts
/**
 * Integration test for hybridSearchContacts against local PGlite.
 * Seeds contacts + hand-written embedding vectors (no AI calls).
 * Stop dev servers on .data/pglite first.
 * Run: npx tsx scripts/smoke-hybrid-search.ts
 */
import { sql, eq } from "drizzle-orm";
import { getDb, isPgvectorAvailable } from "../src/db";
import { contacts, contactEmbeddings, tags, contactTags } from "../src/db/schema";
import { formatVectorLiteral } from "../src/lib/pgvector";
import { hybridSearchContacts } from "../src/lib/hybrid-search";

const U = "smoke-hybrid-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

// Deterministic unit vector along one axis of the 1536-dim space.
function axisVector(axis: number): number[] {
  const v = Array(8).fill(0);
  v[axis] = 1;
  return v; // padded to 1536 by formatVectorLiteral
}

async function cleanup(db: Awaited<ReturnType<typeof getDb>>) {
  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, U));
  await db.delete(tags).where(eq(tags.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, U));
}

async function main() {
  if (process.env.DATABASE_URL) throw new Error("Unset DATABASE_URL — local PGlite only.");
  const db = await getDb();
  check("pgvector available locally (run after Task 1)", isPgvectorAvailable());
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
    const [row] = await db.insert(contactEmbeddings).values({
      userId: U, contactId: contact.id, sourceType: "profile", sourceId: contact.id,
      embedding: axisVector(axis), content: contact.fullName,
    }).returning();
    await db.execute(sql`
      UPDATE contact_embeddings
      SET embedding_vector = ${formatVectorLiteral(axisVector(axis))}::vector
      WHERE id = ${row.id}`);
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/smoke-hybrid-search.ts`
Expected: FAIL — `src/lib/hybrid-search.ts` does not exist.

- [ ] **Step 3: Implement `src/lib/hybrid-search.ts`**

```ts
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  getDb,
  isPgvectorAvailable,
  isTrigramAvailable,
  rowsOf,
} from "@/db";
import { contacts, contactEmbeddings } from "@/db/schema";
import { formatVectorLiteral } from "@/lib/pgvector";
import { cosineSimilarity } from "@/lib/ai";

export type SearchFilters = {
  companies?: string[];
  industries?: string[];
  schools?: string[];
  locations?: string[];
  tags?: string[];
  closenessTiers?: Array<"inner" | "mid" | "outer">;
};

export type HybridSearchOptions = {
  query: string;
  embedding?: number[] | null;
  filters?: SearchFilters | null;
  expansionTerms?: string[];
  limit?: number;
};

export type RankedContact = {
  id: string;
  fullName: string;
  preferredName: string | null;
  company: string | null;
  school: string | null;
  title: string | null;
  location: string | null;
  email: string | null;
  industry: string | null;
  notes: string | null;
  aiSummary: string | null;
  keyFacts: string[];
  relationshipScore: number;
  priorityLevel: number;
  closenessTier: string | null;
  tags: string[];
  rrfScore: number;
  relevance: number;
  matchedArms: Array<"fts" | "trigram" | "semantic">;
};

/** Standard RRF constant: dampens the gap between adjacent ranks. */
const RRF_K = 60;
/** Below this cosine similarity a semantic hit is noise (matches pgvectorSearchContacts). */
const SEMANTIC_SIMILARITY_FLOOR = 0.25;
/** ANN over-fetch multiplier: several embedding rows collapse into one contact. */
const OVERSCAN_FOR_DEDUPE = 4;
/** Ceiling on the JS cosine fallback scan (1,536 floats per row). */
const IN_MEMORY_EMBEDDING_SCAN_LIMIT = 2000;
/** A filtered result set smaller than limit/4 triggers the unfiltered recall guard. */
const RECALL_GUARD_DIVISOR = 4;

type ArmName = "fts" | "trigram" | "semantic";
type ArmResult = { arm: ArmName; ids: string[] };

function anyLike(column: SQL, values: string[]): SQL {
  return sql`(${sql.join(
    values.map((v) => sql`${column} like ${`%${v.toLowerCase()}%`}`),
    sql` or `
  )})`;
}

/** WHERE fragment over the contacts table; null when no filters are set. */
function filterCondition(filters: SearchFilters | null | undefined): SQL | null {
  if (!filters) return null;
  const parts: SQL[] = [];
  const clean = (xs?: string[]) =>
    (xs ?? []).map((x) => x.trim()).filter((x) => x.length > 0).slice(0, 4);

  const companies = clean(filters.companies);
  if (companies.length) parts.push(anyLike(sql`lower(coalesce(contacts.company, ''))`, companies));
  const industries = clean(filters.industries);
  if (industries.length) parts.push(anyLike(sql`lower(coalesce(contacts.industry, ''))`, industries));
  const schools = clean(filters.schools);
  if (schools.length) parts.push(anyLike(sql`lower(coalesce(contacts.school, ''))`, schools));
  const locations = clean(filters.locations);
  if (locations.length) parts.push(anyLike(sql`lower(coalesce(contacts.location, ''))`, locations));

  const tagNames = clean(filters.tags);
  if (tagNames.length) {
    parts.push(sql`exists (
      select 1 from contact_tags ct
      join tags t on t.id = ct.tag_id
      where ct.contact_id = contacts.id
        and (${sql.join(
          tagNames.map((t) => sql`lower(t.name) like ${`%${t.toLowerCase()}%`}`),
          sql` or `
        )})
    )`);
  }

  const tiers = (filters.closenessTiers ?? []).filter((t) =>
    ["inner", "mid", "outer"].includes(t)
  );
  if (tiers.length) {
    parts.push(sql`contacts.closeness_tier in (${sql.join(tiers.map((t) => sql`${t}`), sql`, `)})`);
  }

  if (!parts.length) return null;
  return sql`(${sql.join(parts, sql` and `)})`;
}

async function ftsArm(
  userId: string,
  query: string,
  expansionTerms: string[],
  filter: SQL | null,
  armLimit: number
): Promise<string[]> {
  const db = await getDb();
  // websearch_to_tsquery understands OR; expansion terms widen recall without
  // touching precision (RRF ranks the primary-term matches higher anyway).
  const tsQuery = [query, ...expansionTerms.slice(0, 4)]
    .map((t) => t.trim())
    .filter(Boolean)
    .join(" OR ");
  if (!tsQuery) return [];
  const result = await db.execute(sql`
    select contacts.id
    from contacts
    where contacts.user_id = ${userId}
      and contacts.search_tsv @@ websearch_to_tsquery('simple', ${tsQuery})
      ${filter ? sql`and ${filter}` : sql``}
    order by ts_rank_cd(contacts.search_tsv, websearch_to_tsquery('simple', ${tsQuery})) desc
    limit ${armLimit}
  `);
  return rowsOf<{ id: string }>(result).map((r) => r.id);
}

async function trigramArm(
  userId: string,
  query: string,
  filter: SQL | null,
  armLimit: number
): Promise<string[]> {
  if (!isTrigramAvailable()) return [];
  const q = query.trim().toLowerCase();
  if (q.length < 3) return [];
  const db = await getDb();
  const result = await db.execute(sql`
    select contacts.id
    from contacts
    where contacts.user_id = ${userId}
      and (lower(contacts.full_name) % ${q} or lower(coalesce(contacts.company, '')) % ${q})
      ${filter ? sql`and ${filter}` : sql``}
    order by greatest(
      similarity(lower(contacts.full_name), ${q}),
      similarity(lower(coalesce(contacts.company, '')), ${q})
    ) desc
    limit ${armLimit}
  `);
  return rowsOf<{ id: string }>(result).map((r) => r.id);
}

async function semanticArm(
  userId: string,
  embedding: number[],
  armLimit: number
): Promise<string[]> {
  const db = await getDb();

  if (isPgvectorAvailable()) {
    const literal = formatVectorLiteral(embedding);
    const scanLimit = Math.max(armLimit * OVERSCAN_FOR_DEDUPE, 50);
    // ANN scan must be a bare ORDER BY <=> LIMIT in the innermost query or the
    // HNSW index is unusable (see pgvectorSearchContacts in src/lib/search.ts).
    // Contact-level filters are NOT applied here — an ANN scan cannot filter on
    // the contacts table; filtering happens at hydration.
    const result = await db.execute(sql`
      select contact_id
      from (
        select contact_id, min(distance) as best
        from (
          select contact_id, embedding_vector <=> ${literal}::vector as distance
          from contact_embeddings
          where user_id = ${userId}
            and embedding_vector is not null
          order by embedding_vector <=> ${literal}::vector
          limit ${scanLimit}
        ) nearest
        group by contact_id
        having 1 - min(distance) > ${SEMANTIC_SIMILARITY_FLOOR}
      ) ranked
      order by best asc
      limit ${armLimit}
    `);
    return rowsOf<{ contact_id: string }>(result).map((r) => r.contact_id);
  }

  // Bounded JS fallback: project only what cosine needs, hard row cap.
  const rows = await db.query.contactEmbeddings.findMany({
    where: eq(contactEmbeddings.userId, userId),
    columns: { contactId: true, embedding: true },
    limit: IN_MEMORY_EMBEDDING_SCAN_LIMIT,
  });
  if (rows.length === IN_MEMORY_EMBEDDING_SCAN_LIMIT) {
    console.warn(
      `[hybrid-search] in-memory vector fallback hit its ${IN_MEMORY_EMBEDDING_SCAN_LIMIT}-row cap; semantic results are partial.`
    );
  }
  const best = new Map<string, number>();
  for (const row of rows) {
    const sim = cosineSimilarity(embedding, row.embedding);
    if (sim > (best.get(row.contactId) ?? 0)) best.set(row.contactId, sim);
  }
  return [...best.entries()]
    .filter(([, sim]) => sim > SEMANTIC_SIMILARITY_FLOOR)
    .sort((a, b) => b[1] - a[1])
    .slice(0, armLimit)
    .map(([contactId]) => contactId);
}

function fuse(results: ArmResult[]): Map<string, { score: number; arms: ArmName[] }> {
  const fused = new Map<string, { score: number; arms: ArmName[] }>();
  for (const { arm, ids } of results) {
    ids.forEach((id, index) => {
      const entry = fused.get(id) ?? { score: 0, arms: [] };
      entry.score += 1 / (RRF_K + index + 1);
      entry.arms.push(arm);
      fused.set(id, entry);
    });
  }
  return fused;
}

async function runArms(
  userId: string,
  options: HybridSearchOptions,
  filter: SQL | null,
  armLimit: number
): Promise<ArmResult[]> {
  const [fts, trgm, vec] = await Promise.all([
    ftsArm(userId, options.query, options.expansionTerms ?? [], filter, armLimit),
    trigramArm(userId, options.query, filter, armLimit),
    options.embedding?.length
      ? semanticArm(userId, options.embedding, armLimit)
      : Promise.resolve([]),
  ]);
  return [
    { arm: "fts" as const, ids: fts },
    { arm: "trigram" as const, ids: trgm },
    { arm: "semantic" as const, ids: vec },
  ];
}

export async function hybridSearchContacts(
  userId: string,
  options: HybridSearchOptions
): Promise<RankedContact[]> {
  const limit = Math.min(Math.max(options.limit ?? 12, 1), 80);
  const armLimit = Math.max(limit * 2, 40);
  const filter = filterCondition(options.filters);

  const fused = fuse(await runArms(userId, options, filter, armLimit));
  // The semantic arm is unfiltered (ANN can't see contact columns), so the
  // filter is re-applied at hydration; over-fetch so post-filter still fills a page.
  const orderedIds = [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, filter ? limit * 2 : limit)
    .map(([id]) => id);

  let hydrated = await hydrate(userId, orderedIds, fused, filter);
  hydrated = hydrated.slice(0, limit);

  // Recall guard: an over-narrow filter should widen, not starve.
  if (filter && hydrated.length < Math.ceil(limit / RECALL_GUARD_DIVISOR)) {
    const unfiltered = await hybridSearchContacts(userId, {
      ...options,
      filters: null,
    });
    const seen = new Set(hydrated.map((h) => h.id));
    hydrated = [...hydrated, ...unfiltered.filter((h) => !seen.has(h.id))].slice(0, limit);
  }

  const maxScore = hydrated.reduce((m, h) => Math.max(m, h.rrfScore), 0);
  return hydrated.map((h) => ({
    ...h,
    relevance: maxScore > 0 ? h.rrfScore / maxScore : 0,
  }));
}

async function hydrate(
  userId: string,
  orderedIds: string[],
  fused: Map<string, { score: number; arms: ArmName[] }>,
  filter: SQL | null
): Promise<RankedContact[]> {
  if (orderedIds.length === 0) return [];
  const db = await getDb();
  const rows = await db.query.contacts.findMany({
    where: filter
      ? and(eq(contacts.userId, userId), inArray(contacts.id, orderedIds), filter)
      : and(eq(contacts.userId, userId), inArray(contacts.id, orderedIds)),
    columns: {
      id: true,
      fullName: true,
      preferredName: true,
      company: true,
      school: true,
      title: true,
      location: true,
      email: true,
      industry: true,
      notes: true,
      aiSummary: true,
      keyFacts: true,
      relationshipScore: true,
      priorityLevel: true,
      closenessTier: true,
    },
    with: { contactTags: { with: { tag: true } } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: RankedContact[] = [];
  for (const id of orderedIds) {
    const row = byId.get(id);
    if (!row) continue; // filtered out at hydration, or deleted between arm and hydrate
    const entry = fused.get(id)!;
    out.push({
      id: row.id,
      fullName: row.fullName,
      preferredName: row.preferredName,
      company: row.company,
      school: row.school,
      title: row.title,
      location: row.location,
      email: row.email,
      industry: row.industry,
      notes: row.notes,
      aiSummary: row.aiSummary,
      keyFacts: row.keyFacts ?? [],
      relationshipScore: row.relationshipScore ?? 0,
      priorityLevel: row.priorityLevel ?? 0,
      closenessTier: row.closenessTier,
      tags: row.contactTags?.map((ct) => ct.tag.name) ?? [],
      rrfScore: entry.score,
      relevance: 0, // normalized by caller
      matchedArms: entry.arms,
    });
  }
  return out;
}
```

Notes for the implementer:
- If `relationshipScore`/`priorityLevel`/`keyFacts` column names differ in `schema.ts` (check `src/db/schema.ts:251-359`), match the schema exactly; the hydration `columns` block must only name real schema fields.
- Drizzle's `findMany` accepts raw `SQL` fragments inside `and(...)` — if the installed drizzle version rejects the `filter` fragment there, fall back to `db.execute` with an explicit select of the same columns plus a second small query for tags.

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `npx tsx scripts/smoke-hybrid-search.ts`
Expected: PASS, all 10 checks.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/hybrid-search.ts scripts/smoke-hybrid-search.ts
git commit -m "feat: SQL-side hybrid contact search with RRF fusion"
```

---

### Task 5: Migrate ask-bar/graph search to hybrid search

Kill the per-keystroke full-table load. Short queries stay embedding-free; longer ones use the cached embedding behind a soft timeout so lexical results are never blocked on the embedding API.

**Files:**
- Modify: `src/actions/search.ts` (full rewrite of its internals; exported name and return type unchanged)
- Test: `scripts/smoke-dashboard-search.ts`

**Interfaces:**
- Consumes: `hybridSearchContacts`, `RankedContact` (Task 4); `getQueryEmbedding` (Task 3); `rankKeywordSearch`, `mergeSearchHits` types from `@/lib/keyword-search` (only `KeywordSearchHit`/`SearchableContact` types and `rankKeywordSearch` remain in use).
- Produces: `searchDashboardContacts(query: string, options?: { limit?: number }): Promise<KeywordSearchHit[]>` — same signature as today, so `floating-ask-bar.tsx` and `network-graph.tsx` need no changes.

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/smoke-dashboard-search.ts`. `searchDashboardContacts` calls `requireUserId()`, which needs a request context — so test the new exported pure helper `toKeywordHits` plus the internal decision function instead, and verify by grep that the full-table load is gone:

```ts
/**
 * Verifies the ask-bar search adapter: RankedContact -> KeywordSearchHit mapping
 * and the lexical-only decision for short queries. No DB, no network.
 * Run: npx tsx scripts/smoke-dashboard-search.ts
 */
import { readFileSync } from "node:fs";
import { shouldUseSemanticArm, toKeywordHits } from "../src/actions/search-adapter";
import type { RankedContact } from "../src/lib/hybrid-search";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const ranked: RankedContact = {
  id: "c1", fullName: "Ada Lovelace", preferredName: null, company: "Analytical Engines",
  school: null, title: "Engineer", location: null, email: null, industry: null,
  notes: null, aiSummary: null, keyFacts: [], relationshipScore: 7, priorityLevel: 2,
  closenessTier: "inner", tags: ["mentor"], rrfScore: 0.03, relevance: 1,
  matchedArms: ["fts", "semantic"],
};

async function main() {
  check("1 token -> lexical only", shouldUseSemanticArm("ada") === false);
  check("2 tokens -> lexical only", shouldUseSemanticArm("ada lovelace") === false);
  check("3 tokens -> semantic", shouldUseSemanticArm("who knows ada") === true);

  const hits = toKeywordHits([ranked], "ada");
  check("maps id/name", hits[0].id === "c1" && hits[0].fullName === "Ada Lovelace");
  check("keyword+semantic arms -> hybrid source", hits[0].source === "hybrid");
  check("score carried from relevance", hits[0].score > 0);
  check("keyword-derived matchedFields present", hits[0].matchedFields.includes("name"));

  const semanticOnly = toKeywordHits([{ ...ranked, matchedArms: ["semantic"] }], "zzz");
  check("semantic-only source", semanticOnly[0].source === "semantic");

  const src = readFileSync("src/actions/search.ts", "utf8");
  // The rewrite delegates all data access to hybridSearchContacts — the action
  // file itself should no longer touch tables or embeddings at all.
  check("full-table loadContacts removed", !src.includes("loadContacts") && !src.includes("findMany"));
  check("unbounded embedding fallback removed", !src.includes("contactEmbeddings") && !src.includes("cosineSimilarity"));
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/smoke-dashboard-search.ts`
Expected: FAIL — `src/actions/search-adapter.ts` does not exist.

- [ ] **Step 3: Implement the adapter**

Create `src/actions/search-adapter.ts` (NOT a "use server" file — it exports sync helpers, and a non-async export in a "use server" file breaks every export):

```ts
import {
  rankKeywordSearch,
  type KeywordSearchHit,
  type SearchableContact,
} from "@/lib/keyword-search";
import type { RankedContact } from "@/lib/hybrid-search";

/**
 * 1–2 token queries are lookups (a name, a company); the lexical arms handle
 * them and the embedding round trip adds latency for nothing. Three or more
 * tokens reads as a question — bring in the semantic arm.
 */
export function shouldUseSemanticArm(query: string): boolean {
  return query.trim().split(/\s+/).length >= 3;
}

function toSearchable(c: RankedContact): SearchableContact {
  return {
    id: c.id,
    fullName: c.fullName,
    preferredName: c.preferredName,
    company: c.company,
    school: c.school,
    title: c.title,
    location: c.location,
    email: c.email,
    phone: null,
    linkedinUrl: null,
    website: null,
    howMet: null,
    metContext: null,
    aiSummary: c.aiSummary,
    notes: c.notes,
    industry: c.industry,
    keyFacts: c.keyFacts,
    sharedInterests: null,
    relationshipScore: c.relationshipScore,
    priorityLevel: c.priorityLevel,
    tags: c.tags,
  };
}

/**
 * Adapts hybrid results to the KeywordSearchHit the ask-bar/graph UIs render.
 * matchedFields/explanation come from rankKeywordSearch run over just the
 * returned page (<= 80 rows) — cheap, and keeps the existing match-label UI.
 * Hybrid order is preserved; rankKeywordSearch only annotates.
 */
export function toKeywordHits(
  ranked: RankedContact[],
  query: string
): KeywordSearchHit[] {
  const annotations = new Map(
    rankKeywordSearch(ranked.map(toSearchable), query, ranked.length).map((h) => [h.id, h])
  );
  return ranked.map((c) => {
    const keyword = annotations.get(c.id);
    const hasLexicalArm = c.matchedArms.includes("fts") || c.matchedArms.includes("trigram");
    const hasSemanticArm = c.matchedArms.includes("semantic");
    return {
      id: c.id,
      fullName: c.fullName,
      preferredName: c.preferredName,
      company: c.company,
      title: c.title,
      relationshipScore: c.relationshipScore,
      priorityLevel: c.priorityLevel,
      tags: c.tags,
      score: c.relevance,
      matchedFields: keyword?.matchedFields ?? [],
      explanation: keyword?.explanation ?? "Related to your search",
      source: hasLexicalArm && hasSemanticArm ? "hybrid" : hasSemanticArm ? "semantic" : "keyword",
    };
  });
}
```

If `SearchableContact` requires fields not listed here, mirror its exact type from `src/lib/keyword-search.ts:1-24` — every property present, missing string fields as `null`, missing array fields as `null` or `[]` per the type.

- [ ] **Step 4: Rewrite `src/actions/search.ts`**

Replace the file's contents with:

```ts
"use server";

import { requireUserId } from "@/lib/auth";
import { getQueryEmbedding } from "@/lib/embedding-cache";
import { hybridSearchContacts } from "@/lib/hybrid-search";
import { shouldUseSemanticArm, toKeywordHits } from "@/actions/search-adapter";
import type { KeywordSearchHit } from "@/lib/keyword-search";

/** Lexical results are never held hostage by the embedding API. */
const EMBED_SOFT_TIMEOUT_MS = 300;

async function embeddingWithSoftTimeout(
  userId: string,
  query: string
): Promise<number[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), EMBED_SOFT_TIMEOUT_MS);
  });
  try {
    // On timeout the underlying promise keeps running and lands in the cache,
    // so the next keystroke gets the semantic arm for free.
    return await Promise.race([
      getQueryEmbedding(userId, query).catch(() => null),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function searchDashboardContacts(
  query: string,
  options?: { limit?: number }
): Promise<KeywordSearchHit[]> {
  const q = query.trim();
  if (!q) return [];

  const limit = Math.min(Math.max(options?.limit ?? 12, 1), 80);
  const userId = await requireUserId();

  const embedding =
    q.length >= 3 && shouldUseSemanticArm(q)
      ? await embeddingWithSoftTimeout(userId, q)
      : null;

  const ranked = await hybridSearchContacts(userId, { query: q, embedding, limit });
  return toKeywordHits(ranked, q);
}
```

- [ ] **Step 5: Run the smoke test to verify it passes**

Run: `npx tsx scripts/smoke-dashboard-search.ts`
Expected: PASS, all 10 checks.

- [ ] **Step 6: Manual sanity check in the running app**

Start the dev server (`npm run dev` — use port 3001 if the user's own server occupies 3000; never kill the user's server). In the dashboard ask-bar, type a contact name from seed data and confirm results render with match labels. Stop the server afterwards.

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/actions/search.ts src/actions/search-adapter.ts scripts/smoke-dashboard-search.ts
git commit -m "feat: ask-bar/graph search on hybrid retrieval, no full-table loads"
```

---

### Task 6: Content-hash skip + batched embedding writes

Imports that re-touch unchanged contacts stop paying for re-embeds; embedding writes collapse from one HTTPS round trip per row to one statement per batch.

**Files:**
- Modify: `src/db/schema.ts` (~line 814-832, `contactEmbeddings`)
- Modify: `src/db/index.ts` (SCALE_DDL + SCHEMA_VERSION; `backfillEmbeddingVectors` ~1185-1215)
- Modify: `src/lib/search.ts` (`persistEmbeddingVector`, `upsertContactEmbedding`, `rebuildContactEmbeddingsBatch`)
- Test: `scripts/smoke-embedding-writes.ts`

**Interfaces:**
- Consumes: `createEmbeddingsBatch` signature `(userId: string, texts: string[]) => Promise<number[][]>`.
- Produces: `contactEmbeddings.contentHash` column; `computeContentHash(content: string): string` exported from `src/lib/search.ts`; `rebuildContactEmbeddingsBatch(userId, contactIds, embedFn?)` gains an optional injectable `embedFn` with the `createEmbeddingsBatch` signature (default: the real one).

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/smoke-embedding-writes.ts`:

```ts
/**
 * Verifies content-hash skip and batched embedding writes against local PGlite.
 * Uses an injected stub embedder — no AI calls. Stop dev servers first.
 * Run: npx tsx scripts/smoke-embedding-writes.ts
 */
import { eq, and } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, contactEmbeddings } from "../src/db/schema";
import { computeContentHash, rebuildContactEmbeddingsBatch } from "../src/lib/search";

const U = "smoke-embedwrites-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  if (process.env.DATABASE_URL) throw new Error("Unset DATABASE_URL — local PGlite only.");
  const db = await getDb();
  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, U));

  const inserted = await db.insert(contacts).values([
    { userId: U, fullName: "Ada Lovelace", company: "Analytical Engines" },
    { userId: U, fullName: "Grace Hopper", company: "Navy Research" },
  ]).returning();
  const ids = inserted.map((c) => c.id);

  check("hash is deterministic", computeContentHash("abc") === computeContentHash("abc"));
  check("hash differs on content", computeContentHash("abc") !== computeContentHash("abd"));

  let embedCalls = 0;
  let embeddedTexts = 0;
  const stubEmbed = async (_userId: string, texts: string[]) => {
    embedCalls += 1;
    embeddedTexts += texts.length;
    return texts.map((_, i) => [i + 1, 0.5, 0.25]);
  };

  await rebuildContactEmbeddingsBatch(U, ids, stubEmbed);
  check("first rebuild embeds both contacts", embeddedTexts === 2);

  const rows = await db.query.contactEmbeddings.findMany({
    where: and(eq(contactEmbeddings.userId, U), eq(contactEmbeddings.sourceType, "profile")),
  });
  check("two profile rows written", rows.length === 2);
  check("content_hash populated", rows.every((r) => typeof r.contentHash === "string" && r.contentHash!.length === 64));

  // Second rebuild with unchanged content: zero embedding work.
  await rebuildContactEmbeddingsBatch(U, ids, stubEmbed);
  check("unchanged rebuild embeds nothing", embeddedTexts === 2);

  // Change one contact; only that one re-embeds.
  await db.update(contacts).set({ notes: "Now writes compilers." }).where(eq(contacts.id, ids[0]));
  await rebuildContactEmbeddingsBatch(U, ids, stubEmbed);
  check("only changed contact re-embeds", embeddedTexts === 3);

  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, U));
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/smoke-embedding-writes.ts`
Expected: FAIL — `computeContentHash` is not exported (compile error).

- [ ] **Step 3: Add the column**

In `src/db/schema.ts` `contactEmbeddings` (~814-832), add after `content`:

```ts
contentHash: text("content_hash"),
```

In `src/db/index.ts` SCALE_DDL, add:

```ts
`ALTER TABLE contact_embeddings ADD COLUMN IF NOT EXISTS content_hash text`,
```

Bump `SCHEMA_VERSION` to `9`.

- [ ] **Step 4: Implement hash-skip and batched writes in `src/lib/search.ts`**

Add near the top:

```ts
import { createHash } from "node:crypto";

export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** One set-based UPDATE per batch instead of one HTTPS round trip per row. */
async function persistEmbeddingVectorsBatch(
  rows: Array<{ id: string; embedding: number[] }>
) {
  if (!isPgvectorAvailable() || rows.length === 0) return;
  const db = await getDb();
  const values = sql.join(
    rows.map(
      (r) => sql`(${r.id}::uuid, ${formatVectorLiteral(r.embedding)}::vector)`
    ),
    sql`, `
  );
  await db.execute(sql`
    UPDATE contact_embeddings AS ce
    SET embedding_vector = v.vec
    FROM (VALUES ${values}) AS v(id, vec)
    WHERE ce.id = v.id
  `);
}
```

In `upsertContactEmbedding`, reorder so the hash check happens BEFORE the embedding API call:

```ts
export async function upsertContactEmbedding(
  userId: string,
  contactId: string,
  sourceType: string,
  content: string,
  sourceId?: string
) {
  if (!content.trim()) return;

  try {
    const db = await getDb();
    const contentHash = computeContentHash(content);

    const existing = sourceId
      ? await db.query.contactEmbeddings.findFirst({
          where: and(
            eq(contactEmbeddings.userId, userId),
            eq(contactEmbeddings.contactId, contactId),
            eq(contactEmbeddings.sourceType, sourceType),
            eq(contactEmbeddings.sourceId, sourceId)
          ),
        })
      : undefined;

    // Unchanged content: the stored embedding is still correct — skip the API call.
    if (existing?.contentHash === contentHash) return;

    const embedding = await createEmbedding(userId, content);

    if (existing) {
      await db
        .update(contactEmbeddings)
        .set({ embedding, content, contentHash })
        .where(eq(contactEmbeddings.id, existing.id));
      await persistEmbeddingVectorsBatch([{ id: existing.id, embedding }]);
      return;
    }

    const [inserted] = await db
      .insert(contactEmbeddings)
      .values({ userId, contactId, sourceType, sourceId, embedding, content, contentHash })
      .returning();
    if (inserted?.id) {
      await persistEmbeddingVectorsBatch([{ id: inserted.id, embedding }]);
    }
  } catch {
    // AI key may be missing; skip embeddings silently
  }
}
```

Delete the now-unused single-row `persistEmbeddingVector`.

Rewrite `rebuildContactEmbeddingsBatch` with injectable embedder, hash-skip, and batched updates:

```ts
export async function rebuildContactEmbeddingsBatch(
  userId: string,
  contactIds: string[],
  embedFn: (userId: string, texts: string[]) => Promise<number[][]> = createEmbeddingsBatch
) {
  const ids = [...new Set(contactIds)];
  if (ids.length === 0) return;

  const db = await getDb();
  const rows = await db.query.contacts.findMany({
    where: and(eq(contacts.userId, userId), inArray(contacts.id, ids)),
    with: { contactTags: { with: { tag: true } } },
  });

  const existing = await db.query.contactEmbeddings.findMany({
    where: and(
      eq(contactEmbeddings.userId, userId),
      eq(contactEmbeddings.sourceType, "profile"),
      inArray(contactEmbeddings.contactId, ids)
    ),
    columns: { id: true, contactId: true, contentHash: true },
  });
  const existingByContactId = new Map(existing.map((row) => [row.contactId, row]));

  const entries = rows
    .map((contact) => {
      const content = buildContactEmbeddingContent(contact);
      return { contactId: contact.id, content, contentHash: computeContentHash(content) };
    })
    .filter((entry) => entry.content.trim().length > 0)
    // Unchanged content keeps its stored embedding — no API call, no write.
    .filter(
      (entry) => existingByContactId.get(entry.contactId)?.contentHash !== entry.contentHash
    );
  if (entries.length === 0) return;

  let embeddings: number[][];
  try {
    embeddings = await embedFn(userId, entries.map((entry) => entry.content));
  } catch {
    return; // AI key may be missing; skip silently, matching upsertContactEmbedding.
  }

  const toInsert: Array<typeof contactEmbeddings.$inferInsert> = [];
  const toUpdate: Array<{ id: string; embedding: number[]; content: string; contentHash: string }> = [];

  entries.forEach((entry, index) => {
    const embedding = embeddings[index];
    const found = existingByContactId.get(entry.contactId);
    if (found) {
      toUpdate.push({ id: found.id, embedding, content: entry.content, contentHash: entry.contentHash });
    } else {
      toInsert.push({
        userId,
        contactId: entry.contactId,
        sourceType: "profile",
        sourceId: entry.contactId,
        embedding,
        content: entry.content,
        contentHash: entry.contentHash,
      });
    }
  });

  const vectorRows: Array<{ id: string; embedding: number[] }> = [];

  if (toInsert.length > 0) {
    const inserted = await db.insert(contactEmbeddings).values(toInsert).returning();
    for (const row of inserted) {
      vectorRows.push({ id: row.id, embedding: row.embedding as number[] });
    }
  }

  if (toUpdate.length > 0) {
    const values = sql.join(
      toUpdate.map(
        (u) =>
          sql`(${u.id}::uuid, ${JSON.stringify(u.embedding)}::jsonb, ${u.content}, ${u.contentHash})`
      ),
      sql`, `
    );
    await db.execute(sql`
      UPDATE contact_embeddings AS ce
      SET embedding = v.embedding, content = v.content, content_hash = v.content_hash
      FROM (VALUES ${values}) AS v(id, embedding, content, content_hash)
      WHERE ce.id = v.id
    `);
    for (const u of toUpdate) vectorRows.push({ id: u.id, embedding: u.embedding });
  }

  await persistEmbeddingVectorsBatch(vectorRows);
}
```

- [ ] **Step 5: Batch the cron backfill**

In `src/db/index.ts`, rewrite the loop body of `backfillEmbeddingVectors` (keep the SELECT): collect valid rows, then issue ONE statement:

```ts
  const valid = rows.filter(
    (row) => Array.isArray(row.embedding) && row.embedding.length > 0
  );
  if (valid.length === 0) return 0;

  const params: unknown[] = [];
  const tuples = valid
    .map((row, i) => {
      params.push(row.id, formatVectorLiteral(row.embedding));
      return `($${i * 2 + 1}::uuid, $${i * 2 + 2}::vector)`;
    })
    .join(", ");
  await sql.query(
    `UPDATE contact_embeddings AS ce
     SET embedding_vector = v.vec
     FROM (VALUES ${tuples}) AS v(id, vec)
     WHERE ce.id = v.id`,
    params
  );
  return valid.length;
```

Update the function's doc comment: it is now one round trip per run, not per row (it can return to being callable more aggressively, but leave the cron cadence alone).

- [ ] **Step 6: Embedding-content audit (spec §3)**

Read `buildContactEmbeddingContent` (`src/lib/search.ts:342`) and every `upsertContactEmbedding` call site (`grep -rn "upsertContactEmbedding" src/`). Verify the per-source chunking the spec assumes:

1. The `profile` source must NOT swallow content that has its own source row. If any call site writes LinkedIn messages or interaction notes into the profile blob, split them: one `upsertContactEmbedding(userId, contactId, "interaction", text, interactionId)` per interaction (the `sourceType`/`sourceId` columns and the dedupe path already support this).
2. Any single content string that exceeds the 8,000-char embedding truncation (`src/lib/ai.ts:1165`) loses its tail silently. For `profile` content: if `content.length > 8000`, split `notes` out into its own source row (`sourceType: "notes"`, `sourceId: contactId`) so both chunks embed fully. Implement the split inside `rebuildContactEmbedding`/`rebuildContactEmbeddingsBatch` (build profile-without-notes + a separate notes entry when the combined length exceeds 8,000; otherwise keep the single row as today, so small contacts don't double their row count).

If the audit finds the current chunking already satisfies both points, record that as a code comment above `buildContactEmbeddingContent` and change nothing.

- [ ] **Step 7: Run the smoke test to verify it passes**

Run: `npx tsx scripts/smoke-embedding-writes.ts`
Expected: PASS, all 7 checks.

- [ ] **Step 8: Regression: existing smokes + typecheck, then commit**

```bash
npx tsc --noEmit
npx tsx scripts/smoke-hybrid-search.ts
git add src/db/schema.ts src/db/index.ts src/lib/search.ts scripts/smoke-embedding-writes.ts
git commit -m "feat: content-hash embedding skip + batched embedding writes"
```

---

### Task 7: Fast-model tier for pipeline stages

Intermediate chat stages (query understanding, rerank) run on the cheapest model of the user's provider; only the final answer uses their chosen model.

**Files:**
- Modify: `src/lib/ai.ts` (`completeJson` ~line 416-430)
- Test: `scripts/smoke-fast-model.ts`

**Interfaces:**
- Consumes: `getAiConfig`, `AiProvider`.
- Produces: `completeJson` accepts optional `speed?: "fast"`; exported `FAST_MODELS: Record<AiProvider, string>` from `src/lib/ai.ts`.

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/smoke-fast-model.ts`:

```ts
/**
 * Verifies the fast-model map covers every provider with a known cheap model.
 * No DB, no network. Run: npx tsx scripts/smoke-fast-model.ts
 */
import { FAST_MODELS } from "../src/lib/ai";
import { AI_PROVIDERS, PROVIDER_MODELS } from "../src/lib/ai-providers";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  for (const p of AI_PROVIDERS) {
    const fast = FAST_MODELS[p.id];
    check(`${p.id} has a fast model`, typeof fast === "string" && fast.length > 0);
    check(
      `${p.id} fast model is in the known roster`,
      PROVIDER_MODELS[p.id].some((m) => m.value === fast),
      fast
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/smoke-fast-model.ts`
Expected: FAIL — `FAST_MODELS` is not exported.

- [ ] **Step 3: Implement**

In `src/lib/ai.ts`, near the embedding model constants (~line 160):

```ts
/**
 * Cheapest usable model per provider, for accuracy-stage calls (query
 * understanding, rerank) where the user's configured model would be overkill.
 * Values must exist in PROVIDER_MODELS (smoke-fast-model.ts enforces this).
 */
export const FAST_MODELS: Record<AiProvider, string> = {
  gemini: "gemini-3.1-flash-lite",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
};
```

In `completeJson`, add to the input type:

```ts
    /** "fast" routes to FAST_MODELS[provider] instead of the user's configured model. */
    speed?: "fast";
```

And after `getAiConfig`:

```ts
  const { provider, model: configuredModel, apiKey, keyOwner } = await getAiConfig(userId);
  const model = input.speed === "fast" ? FAST_MODELS[provider] : configuredModel;
```

(The rest of the function already uses `model` — verify all three provider branches and the `withUsage` metadata reference the new `model` variable.)

- [ ] **Step 4: Run the smoke test, typecheck, commit**

Run: `npx tsx scripts/smoke-fast-model.ts` → PASS (6 checks).

```bash
npx tsc --noEmit
git add src/lib/ai.ts scripts/smoke-fast-model.ts
git commit -m "feat: fast-model tier for intermediate AI pipeline stages"
```

---

### Task 8: Query understanding stage

A flash-tier pre-pass that turns a natural question into a semantic query, structured filters, and expansion terms. Accuracy-only: any failure or timeout degrades to pass-through.

**Files:**
- Create: `src/lib/chat-retrieval.ts`
- Test: `scripts/smoke-chat-retrieval.ts`

**Interfaces:**
- Consumes: `completeJson` (+`speed: "fast"`), `parseAiJson` from `@/lib/ai`; `SearchFilters` from `@/lib/hybrid-search`.
- Produces:

```ts
export type ParsedQuery = {
  semanticQuery: string;
  filters: SearchFilters;
  expansionTerms: string[];
};
export function fallbackParsedQuery(question: string): ParsedQuery;
export async function understandQuery(
  userId: string,
  question: string,
  userGoals: string[],
  completeFn?: typeof completeJson  // injectable for tests
): Promise<ParsedQuery>;
export function sanitizeParsedQuery(raw: unknown, question: string): ParsedQuery; // exported for tests
```

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/smoke-chat-retrieval.ts` (this file grows in Task 9; start it now):

```ts
/**
 * Unit tests for the chat retrieval pipeline stages (query understanding,
 * rerank, context budgeting) with stubbed AI calls. No DB, no network.
 * Run: npx tsx scripts/smoke-chat-retrieval.ts
 */
import {
  fallbackParsedQuery,
  sanitizeParsedQuery,
  understandQuery,
} from "../src/lib/chat-retrieval";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const fb = fallbackParsedQuery("who knows rust?");
  check("fallback echoes question", fb.semanticQuery === "who knows rust?");
  check("fallback has no filters", Object.keys(fb.filters).length === 0);

  const sane = sanitizeParsedQuery(
    {
      semanticQuery: "engineers at fintech companies",
      filters: {
        industries: ["fintech"],
        companies: ["  Stripe  ", "", "a", "b", "c", "d"], // 6 entries incl junk
        closenessTiers: ["inner", "bogus"],
      },
      expansionTerms: ["finance", "payments", 42],
    },
    "who at a fintech?"
  );
  check("keeps semantic query", sane.semanticQuery === "engineers at fintech companies");
  check("trims + caps companies at 4", sane.filters.companies!.length <= 4 && sane.filters.companies![0] === "Stripe");
  check("drops invalid tier", sane.filters.closenessTiers!.length === 1 && sane.filters.closenessTiers![0] === "inner");
  check("drops non-string expansion terms", sane.expansionTerms.every((t) => typeof t === "string"));

  const junk = sanitizeParsedQuery({ nonsense: true }, "raw question");
  check("garbage parse degrades to fallback", junk.semanticQuery === "raw question");

  // understandQuery with a stub that returns valid JSON
  const okStub = (async (_userId: string, _input: unknown) =>
    JSON.stringify({
      semanticQuery: "people who invest",
      filters: { tags: ["investor"] },
      expansionTerms: ["vc"],
    })) as never;
  const parsed = await understandQuery("u1", "which of my contacts invest?", [], okStub);
  check("stub parse flows through", parsed.filters.tags?.[0] === "investor");

  // understandQuery with a stub that throws -> fallback, never an exception
  const failStub = (async () => {
    throw new Error("provider down");
  }) as never;
  const degraded = await understandQuery("u1", "which of my contacts invest?", [], failStub);
  check("stage failure degrades to fallback", degraded.semanticQuery === "which of my contacts invest?");
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/smoke-chat-retrieval.ts`
Expected: FAIL — `src/lib/chat-retrieval.ts` does not exist.

- [ ] **Step 3: Implement the module**

Create `src/lib/chat-retrieval.ts`:

```ts
import { completeJson, parseAiJson } from "@/lib/ai";
import type { SearchFilters } from "@/lib/hybrid-search";

export type ParsedQuery = {
  semanticQuery: string;
  filters: SearchFilters;
  expansionTerms: string[];
};

const UNDERSTAND_TIMEOUT_MS = 2500;
const MAX_FILTER_VALUES = 4;
const VALID_TIERS = new Set(["inner", "mid", "outer"]);

export function fallbackParsedQuery(question: string): ParsedQuery {
  return { semanticQuery: question, filters: {}, expansionTerms: [] };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("stage timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 1)
    .slice(0, MAX_FILTER_VALUES);
}

export function sanitizeParsedQuery(raw: unknown, question: string): ParsedQuery {
  const fallback = fallbackParsedQuery(question);
  if (!raw || typeof raw !== "object") return fallback;
  const obj = raw as Record<string, unknown>;
  const semanticQuery =
    typeof obj.semanticQuery === "string" && obj.semanticQuery.trim().length > 0
      ? obj.semanticQuery.trim()
      : question;

  const rawFilters = (obj.filters ?? {}) as Record<string, unknown>;
  const filters: SearchFilters = {};
  const companies = cleanStringArray(rawFilters.companies);
  if (companies.length) filters.companies = companies;
  const industries = cleanStringArray(rawFilters.industries);
  if (industries.length) filters.industries = industries;
  const schools = cleanStringArray(rawFilters.schools);
  if (schools.length) filters.schools = schools;
  const locations = cleanStringArray(rawFilters.locations);
  if (locations.length) filters.locations = locations;
  const tags = cleanStringArray(rawFilters.tags);
  if (tags.length) filters.tags = tags;
  const tiers = cleanStringArray(rawFilters.closenessTiers).filter((t) =>
    VALID_TIERS.has(t)
  ) as Array<"inner" | "mid" | "outer">;
  if (tiers.length) filters.closenessTiers = tiers;

  return {
    semanticQuery,
    filters,
    expansionTerms: cleanStringArray(obj.expansionTerms),
  };
}

const UNDERSTAND_SYSTEM = `You turn a question about someone's personal/professional network into a retrieval plan.
Extract only what the question explicitly states or strongly implies. Do not guess.
Filters narrow a database query over the user's contacts:
- companies, industries, schools, locations: substring matches (e.g. "fintech", "Stanford")
- tags: user-defined labels (e.g. "mentor", "investor")
- closenessTiers: subset of ["inner","mid","outer"] — ONLY when the question references closeness ("close friends" -> ["inner"], "acquaintances" -> ["outer"])
Self-references ("my school", "my company") can only be resolved from the user context provided; if it does not name one, OMIT that filter — never invent a value.
expansionTerms: up to 4 synonyms/adjacent terms that widen a keyword search (e.g. question about "AI" -> ["machine learning", "ML"]).
semanticQuery: the question rewritten as a dense retrieval query describing the ideal matching contact.
Return JSON: {"semanticQuery": string, "filters": {"companies"?: string[], "industries"?: string[], "schools"?: string[], "locations"?: string[], "tags"?: string[], "closenessTiers"?: string[]}, "expansionTerms": string[]}`;

/**
 * Accuracy-only stage: on any failure or timeout it returns the pass-through
 * fallback. It must never throw and never block the pipeline.
 */
export async function understandQuery(
  userId: string,
  question: string,
  userGoals: string[],
  completeFn: typeof completeJson = completeJson
): Promise<ParsedQuery> {
  const fallback = fallbackParsedQuery(question);
  if (question.trim().length < 8) return fallback;
  try {
    const goalsBlock = userGoals.length
      ? `User context — their active networking goals:\n${userGoals.map((g) => `- ${g}`).join("\n")}\n\n`
      : "";
    const content = await withTimeout(
      completeFn(userId, {
        operation: "chat.understand",
        speed: "fast",
        temperature: 0,
        maxOutputTokens: 512,
        system: UNDERSTAND_SYSTEM,
        user: `${goalsBlock}Question: ${question}`,
      }),
      UNDERSTAND_TIMEOUT_MS
    );
    return sanitizeParsedQuery(parseAiJson(content), question);
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `npx tsx scripts/smoke-chat-retrieval.ts`
Expected: PASS, all 10 checks.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/chat-retrieval.ts scripts/smoke-chat-retrieval.ts
git commit -m "feat: flash-tier query understanding stage for chat retrieval"
```

---

### Task 9: LLM rerank + token-budgeted context builder

The biggest accuracy lever: ~60 candidates scored by a flash-tier model, top 12 kept; survivors get context sized by rank under a total budget.

**Files:**
- Modify: `src/lib/chat-retrieval.ts`
- Test: extend `scripts/smoke-chat-retrieval.ts`

**Interfaces:**
- Consumes: `RankedContact` (Task 4); `completeJson`/`parseAiJson`.
- Produces (Task 10 consumes these exactly):

```ts
export const CANDIDATE_POOL = 60;
export const FINAL_CONTACT_COUNT = 12;
export async function rerankCandidates(
  userId: string,
  question: string,
  candidates: RankedContact[],
  completeFn?: typeof completeJson
): Promise<RankedContact[]>;

export type BudgetedContact = {
  id: string; fullName: string; company: string | null; title: string | null;
  relationshipScore: number; aiSummary: string | null; notes: string | null;
  keyFacts: string[]; recentMessages: string[]; tags: string[]; relevance: number;
};
export function budgetContactsContext(
  contacts: RankedContact[],
  snippets: Map<string, { recentMessages: string[] }>
): BudgetedContact[];
```

`BudgetedContact` is intentionally the exact element type of `chatWithNetwork`'s `contactsContext` parameter (`src/lib/ai.ts:1275-1287`).

- [ ] **Step 1: Extend the smoke test (failing)**

Append to `scripts/smoke-chat-retrieval.ts` `main()` (before the final closing brace) and add imports for `rerankCandidates`, `budgetContactsContext`, `FINAL_CONTACT_COUNT`, and `type RankedContact` from the respective modules:

```ts
  // ---- rerank ----
  const mkCandidate = (id: string, name: string): RankedContact => ({
    id, fullName: name, preferredName: null, company: null, school: null,
    title: null, location: null, email: null, industry: null, notes: null,
    aiSummary: null, keyFacts: [], relationshipScore: 5, priorityLevel: 1,
    closenessTier: null, tags: [], rrfScore: 0.02, relevance: 0.9,
    matchedArms: ["fts"],
  });
  const pool = Array.from({ length: 20 }, (_, i) => mkCandidate(`c${i}`, `Person ${i}`));

  const rerankStub = (async (_u: string, _input: unknown) =>
    JSON.stringify({
      scores: [
        { id: "c7", relevance: 9 },
        { id: "c3", relevance: 8 },
        { id: "c19", relevance: 7 },
        { id: "c0", relevance: 2 },          // below threshold
        { id: "hallucinated", relevance: 10 }, // not a candidate
      ],
    })) as never;
  const reranked = await rerankCandidates("u1", "q", pool, rerankStub);
  check("rerank orders by relevance", reranked[0].id === "c7" && reranked[1].id === "c3");
  check("rerank drops below-threshold", !reranked.some((c) => c.id === "c0"));
  check("rerank drops hallucinated ids", !reranked.some((c) => c.id === "hallucinated"));
  check("rerank caps at FINAL_CONTACT_COUNT", reranked.length <= FINAL_CONTACT_COUNT);

  const rerankFail = (async () => { throw new Error("down"); }) as never;
  const fallbackOrder = await rerankCandidates("u1", "q", pool, rerankFail);
  check("rerank failure falls back to RRF order", fallbackOrder.length === FINAL_CONTACT_COUNT && fallbackOrder[0].id === "c0");

  const small = await rerankCandidates("u1", "q", pool.slice(0, 5), rerankFail);
  check("small pool skips rerank", small.length === 5);

  // ---- budget ----
  const longNotes = "x".repeat(5000);
  const budgetPool = Array.from({ length: 12 }, (_, i) => ({
    ...mkCandidate(`b${i}`, `Person ${i}`),
    notes: longNotes,
    keyFacts: Array.from({ length: 12 }, (_, j) => `fact ${j}`),
  }));
  const snippets = new Map(
    budgetPool.map((c) => [
      c.id,
      { recentMessages: Array.from({ length: 10 }, (_, j) => "m".repeat(400) + j) },
    ])
  );
  const budgeted = budgetContactsContext(budgetPool, snippets);
  check("budget keeps order", budgeted[0].id === "b0");
  check("top tier gets more notes than tail", budgeted[0].notes!.length > budgeted[11].notes!.length);
  check("messages trimmed per tier", budgeted[0].recentMessages.length <= 8 && budgeted[11].recentMessages.length <= 2);
  const totalChars = budgeted.reduce(
    (n, c) =>
      n + (c.notes?.length ?? 0) + (c.aiSummary?.length ?? 0) +
      c.recentMessages.join("").length + c.keyFacts.join("").length,
    0
  );
  check("total context under budget", totalChars <= 48000);
```

- [ ] **Step 2: Run to verify the new checks fail**

Run: `npx tsx scripts/smoke-chat-retrieval.ts`
Expected: FAIL — `rerankCandidates` not exported.

- [ ] **Step 3: Implement in `src/lib/chat-retrieval.ts`**

Add (importing `type RankedContact` from `@/lib/hybrid-search`):

```ts
export const CANDIDATE_POOL = 60;
export const FINAL_CONTACT_COUNT = 12;
const RERANK_TIMEOUT_MS = 6000;
const RERANK_MIN_RELEVANCE = 3;
const RERANK_MIN_SURVIVORS = 3;

const RERANK_SYSTEM = `You score how relevant each candidate contact is to the user's question about their network.
10 = directly answers the question. 5 = plausibly useful. 0 = unrelated.
Judge from the card text only. Score every candidate you were given, using their exact ids.
Return JSON: {"scores": [{"id": string, "relevance": number}]}`;

function candidateCard(c: RankedContact): string {
  const summary = (c.aiSummary || c.notes || "").replace(/\s+/g, " ").slice(0, 160);
  return `[id=${c.id}] ${c.fullName} | ${c.title || "?"} @ ${c.company || "?"} | school=${c.school || "?"} | industry=${c.industry || "?"} | tier=${c.closenessTier || "?"} | tags=${c.tags.join(",") || "-"}${summary ? ` | ${summary}` : ""}`;
}

/**
 * Accuracy-only stage: scores candidates with a flash-tier model and keeps the
 * best FINAL_CONTACT_COUNT. On any failure it falls back to RRF order. Never throws.
 */
export async function rerankCandidates(
  userId: string,
  question: string,
  candidates: RankedContact[],
  completeFn: typeof completeJson = completeJson
): Promise<RankedContact[]> {
  if (candidates.length <= FINAL_CONTACT_COUNT) return candidates;
  try {
    const content = await withTimeout(
      completeFn(userId, {
        operation: "chat.rerank",
        speed: "fast",
        temperature: 0,
        maxOutputTokens: 2048,
        system: RERANK_SYSTEM,
        user: `Question: ${question}\n\nCandidates:\n${candidates.map(candidateCard).join("\n")}`,
      }),
      RERANK_TIMEOUT_MS
    );
    const parsed = parseAiJson<{ scores?: Array<{ id?: unknown; relevance?: unknown }> }>(content);
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const scored = (parsed.scores ?? [])
      .filter(
        (s): s is { id: string; relevance: number } =>
          typeof s.id === "string" && byId.has(s.id) && typeof s.relevance === "number"
      )
      .sort((a, b) => b.relevance - a.relevance);

    const kept = scored
      .filter((s) => s.relevance >= RERANK_MIN_RELEVANCE)
      .slice(0, FINAL_CONTACT_COUNT)
      .map((s) => byId.get(s.id)!);
    if (kept.length >= RERANK_MIN_SURVIVORS) return kept;

    // Threshold starved the set — trust the model's ordering for a smaller page.
    const ordered = scored.slice(0, 5).map((s) => byId.get(s.id)!);
    return ordered.length > 0 ? ordered : candidates.slice(0, FINAL_CONTACT_COUNT);
  } catch {
    return candidates.slice(0, FINAL_CONTACT_COUNT);
  }
}

export type BudgetedContact = {
  id: string;
  fullName: string;
  company: string | null;
  title: string | null;
  relationshipScore: number;
  aiSummary: string | null;
  notes: string | null;
  keyFacts: string[];
  recentMessages: string[];
  tags: string[];
  relevance: number;
};

/**
 * Per-contact context caps by rank tier, under one total character budget
 * (~12k tokens at 4 chars/token). Reranked survivors earned richer detail than
 * the old flat 400-chars-of-notes: rank buys depth.
 */
const CONTEXT_TIERS = [
  { upto: 4, notes: 1200, summary: 600, msgs: 8, msgChars: 320, facts: 8 },
  { upto: 8, notes: 600, summary: 400, msgs: 4, msgChars: 280, facts: 6 },
  { upto: Infinity, notes: 300, summary: 240, msgs: 2, msgChars: 240, facts: 4 },
] as const;
const TOTAL_CONTEXT_CHAR_BUDGET = 48000;

export function budgetContactsContext(
  contacts: RankedContact[],
  snippets: Map<string, { recentMessages: string[] }>
): BudgetedContact[] {
  const out: BudgetedContact[] = [];
  let spent = 0;
  contacts.forEach((c, index) => {
    const tier = CONTEXT_TIERS.find((t) => index < t.upto)!;
    const notes = (c.notes || "").slice(0, tier.notes) || null;
    const aiSummary = (c.aiSummary || "").slice(0, tier.summary) || null;
    const keyFacts = c.keyFacts.slice(0, tier.facts);
    const recentMessages = (snippets.get(c.id)?.recentMessages ?? [])
      .slice(0, tier.msgs)
      .map((m) => m.slice(0, tier.msgChars));

    const cost =
      c.fullName.length + (c.company?.length ?? 0) + (c.title?.length ?? 0) +
      (notes?.length ?? 0) + (aiSummary?.length ?? 0) +
      keyFacts.join("").length + recentMessages.join("").length +
      c.tags.join("").length + 80; // formatting overhead
    if (spent + cost > TOTAL_CONTEXT_CHAR_BUDGET && out.length > 0) return;
    spent += cost;

    out.push({
      id: c.id,
      fullName: c.fullName,
      company: c.company,
      title: c.title,
      relationshipScore: c.relationshipScore,
      aiSummary,
      notes,
      keyFacts,
      recentMessages,
      tags: c.tags,
      relevance: c.relevance,
    });
  });
  return out;
}
```

- [ ] **Step 4: Raise chatWithNetwork's internal caps**

`src/lib/ai.ts:1303-1318` re-trims what the budget already sized. Raise its slice caps so the budget is authoritative: `keyFacts.slice(0, 8)` stays; change `recentMessages.slice(0, 6)` → `slice(0, 8)`; change `(c.notes || "").slice(0, 400)` → `slice(0, 1200)`. (Callers that never budget — none after Task 10 — would still be capped sanely.)

- [ ] **Step 5: Run the smoke test to verify all checks pass**

Run: `npx tsx scripts/smoke-chat-retrieval.ts`
Expected: PASS — the 10 checks from Task 8 plus the 12 new ones.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/chat-retrieval.ts src/lib/ai.ts scripts/smoke-chat-retrieval.ts
git commit -m "feat: LLM rerank stage and token-budgeted chat context"
```

---

### Task 10: Wire the pipeline into askNetwork

Replace the single `semanticSearchContacts` call with: (embed ∥ understand) → wide hybrid retrieval → rerank → budgeted answer. Focus-contact, recruiters, threads, and the hallucination filter are preserved.

**Files:**
- Modify: `src/actions/chat.ts` (~lines 12-13 imports, 179-265 retrieval + context assembly)
- Test: `scripts/smoke-chat-pipeline.ts`

**Interfaces:**
- Consumes: `getQueryEmbedding` (Task 3); `hybridSearchContacts`, `RankedContact` (Task 4); `CANDIDATE_POOL`, `understandQuery`, `rerankCandidates`, `budgetContactsContext` (Tasks 8–9); `userGoals` table from `@/db/schema`.
- Produces: `askNetwork` behavior unchanged in signature and return shape (`retrieved` still `{id, fullName, company, title, relevance}[]`).

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/smoke-chat-pipeline.ts` — a structural test (the full action needs auth + AI keys; the pipeline stages are already unit-tested). It verifies wiring by source inspection plus type-level import:

```ts
/**
 * Structural checks that askNetwork runs the new pipeline: parallel
 * embed+understand, hybrid retrieval at CANDIDATE_POOL, rerank, budget.
 * Run: npx tsx scripts/smoke-chat-pipeline.ts
 */
import { readFileSync } from "node:fs";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const src = readFileSync("src/actions/chat.ts", "utf8");
  check("no semanticSearchContacts call", !src.includes("semanticSearchContacts"));
  check("uses hybridSearchContacts", src.includes("hybridSearchContacts"));
  check("embed and understand run in parallel", /Promise\.all\(\[\s*getQueryEmbedding/.test(src));
  check("uses CANDIDATE_POOL", src.includes("CANDIDATE_POOL"));
  check("reranks", src.includes("rerankCandidates"));
  check("budgets context", src.includes("budgetContactsContext"));
  check("hallucination filter intact", src.includes("allowedContacts"));
  check("recruiter path intact", src.includes("loadRecruitersForChat"));
  check("focus contact path intact", src.includes("focusContactId"));

  // The action module must remain a valid "use server" file (async exports only).
  const exportsNonAsync = /export (function|const|let|var) /.test(src);
  check("no non-async exports in use-server file", !exportsNonAsync);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/smoke-chat-pipeline.ts`
Expected: FAIL at "no semanticSearchContacts call".

- [ ] **Step 3: Rewire askNetwork**

In `src/actions/chat.ts`:

Replace the import of `semanticSearchContacts` with:

```ts
import { getQueryEmbedding } from "@/lib/embedding-cache";
import { hybridSearchContacts, type RankedContact } from "@/lib/hybrid-search";
import {
  budgetContactsContext,
  CANDIDATE_POOL,
  rerankCandidates,
  understandQuery,
} from "@/lib/chat-retrieval";
import { userGoals } from "@/db/schema";
```

(Merge `userGoals` into the existing `@/db/schema` import.)

Replace line 179 (`const retrieved = await semanticSearchContacts(userId, q, 12);`) with:

```ts
    // Stage 0 + 1 in parallel: the query embedding (cached) and the flash-tier
    // query parse. Both are accuracy-only — either can fail without blocking.
    const activeGoals = await db.query.userGoals.findMany({
      where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
      columns: { text: true },
      limit: 5,
    });
    const [queryEmbedding, parsedQuery] = await Promise.all([
      getQueryEmbedding(userId, q).catch(() => null),
      understandQuery(userId, q, activeGoals.map((g) => g.text)),
    ]);

    // Stage 2: wide retrieval. Lexical arms use the raw question (names are
    // typed verbatim); the parse contributes filters and expansion terms.
    const candidates = await hybridSearchContacts(userId, {
      query: q,
      embedding: queryEmbedding,
      filters: parsedQuery.filters,
      expansionTerms: parsedQuery.expansionTerms,
      limit: CANDIDATE_POOL,
    });

    // Stage 3: flash-tier rerank down to the answer set.
    const retrieved = await rerankCandidates(userId, q, candidates);
```

The focus-contact splice block (~181-211) stays, with two adjustments:
- `focusEntry` must now satisfy `RankedContact`: build it with every `RankedContact` field (`preferredName`, `school`, `location`, `email`, `industry`, `closenessTier`, `keyFacts: focused.keyFacts || []`, `rrfScore: 1`, `relevance: 1`, `matchedArms: []`, `tags: focused.contactTags.map((ct) => ct.tag.name)`, plus the fields it already sets). Remove the `as (typeof retrieved)[number]` cast — it should typecheck directly.
- `retrieved.splice(0, retrieved.length, focusEntry, ...without.slice(0, 11))` keeps the page at 12.

Replace the context assembly at ~250-265: `loadKnowledgeSnippets` and the focus-contact snippet override stay as-is; then:

```ts
    // Stage 4 prep: context sized by rank under a total budget.
    const budgeted = budgetContactsContext(retrieved, snippets);

    const result = await chatWithNetwork(
      userId,
      scopedQuestion,
      budgeted,
      priorTurns,
      recruitersForChat.map((r) => ({
        id: r.id,
        fullName: r.fullName,
        firm: r.firm,
        specialty: r.specialty,
        avgRating: r.avgRating,
        logCount: r.logCount,
        personalRating: r.personalRating,
        status: r.status,
        notes: r.notes,
        piiUnlocked: r.piiUnlocked,
        relevance: r.score / maxScore,
      }))
    );
```

(The recruiter mapping is byte-identical to the existing one at `src/actions/chat.ts:267-279`; only the contact argument changes. Delete the old inline `retrieved.map((c) => ({...}))` contact mapping — `budgetContactsContext` produces exactly `chatWithNetwork`'s expected element type.)

The `retrieved:` field of the return value at ~326-332 keeps mapping over `retrieved` — its fields (`id, fullName, company, title, relevance`) all exist on `RankedContact`.

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `npx tsx scripts/smoke-chat-pipeline.ts`
Expected: PASS, all 10 checks.

- [ ] **Step 5: End-to-end sanity check (requires a configured AI key locally)**

Stop other writers, start the dev server, open the chat, and ask one attribute question ("who works in fintech?") and one name-typo question against seeded data. Confirm an answer arrives and recommendations reference real contacts. If no local AI key is configured, note that in the commit message and rely on the unit smokes.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/actions/chat.ts scripts/smoke-chat-pipeline.ts
git commit -m "feat: accuracy-first chat pipeline (understand -> hybrid retrieve -> rerank -> budgeted answer)"
```

---

### Task 11: Retrieval eval harness

A number, not a vibe: recall@12 and recall@60 over fixture questions against a seeded network. Runs lexical-only without an AI key; adds the semantic arm and rerank stages when a key is configured.

**Files:**
- Create: `scripts/eval-retrieval.ts`
- Create: `scripts/eval-fixtures/contact-search-eval.json`
- Test: the script IS the test; a run with exit 0 and a printed report is success.

**Interfaces:**
- Consumes: `hybridSearchContacts`, `rebuildContactEmbeddingsBatch`, `getQueryEmbedding`, `rerankCandidates`.
- Produces: console report `recall@12`, `recall@60`, per-case pass/fail table.

- [ ] **Step 1: Create the fixtures**

Create `scripts/eval-fixtures/contact-search-eval.json`. Contacts are keyed by `email` (stable across seeding). Cases list expected emails; a case passes at k when every expected contact appears in the top-k:

```json
{
  "contacts": [
    { "email": "maya@stripe.example", "fullName": "Maya Chen", "company": "Stripe", "title": "Payments Engineer", "school": "Stanford", "industry": "fintech", "location": "San Francisco", "notes": "Worked on card auth rates. Loves rock climbing.", "tags": ["engineer"] },
    { "email": "dev@plaid.example", "fullName": "Dev Patel", "company": "Plaid", "title": "Product Manager", "school": "Berkeley", "industry": "fintech", "location": "New York", "notes": "Building bank-linking APIs.", "tags": ["product"] },
    { "email": "sofia@openai.example", "fullName": "Sofia Alvarez", "company": "OpenAI", "title": "Research Engineer", "school": "MIT", "industry": "ai", "location": "San Francisco", "notes": "Published on retrieval-augmented generation.", "tags": ["engineer", "ai"] },
    { "email": "james@sequoia.example", "fullName": "James Okafor", "company": "Sequoia Capital", "title": "Partner", "school": "Harvard", "industry": "venture capital", "location": "Menlo Park", "notes": "Leads fintech investments. Met at Money2020.", "tags": ["investor"] },
    { "email": "lena@figma.example", "fullName": "Lena Kowalski", "company": "Figma", "title": "Design Lead", "school": "RISD", "industry": "design", "location": "Brooklyn", "notes": "Mentors early-career designers.", "tags": ["mentor", "design"] },
    { "email": "tom@datadog.example", "fullName": "Tomás Rivera", "company": "Datadog", "title": "SRE Manager", "school": "Georgia Tech", "industry": "infrastructure", "location": "Boston", "notes": "Hiring SREs. Big into homebrewing.", "tags": ["hiring"] },
    { "email": "prisha@ramp.example", "fullName": "Prisha Narayanan", "company": "Ramp", "title": "Growth Marketer", "school": "NYU", "industry": "fintech", "location": "New York", "notes": "Ran the SMB card launch campaign.", "tags": ["marketing"] },
    { "email": "erik@spotify.example", "fullName": "Erik Lindqvist", "company": "Spotify", "title": "Machine Learning Engineer", "school": "KTH", "industry": "music tech", "location": "Stockholm", "notes": "Recommender systems for podcasts.", "tags": ["engineer", "ai"] },
    { "email": "hana@notion.example", "fullName": "Hana Suzuki", "company": "Notion", "title": "Recruiter", "school": "UCLA", "industry": "productivity", "location": "San Francisco", "notes": "Recruits senior engineers. Very responsive.", "tags": ["recruiter"] },
    { "email": "omar@stripe.example", "fullName": "Omar Haddad", "company": "Stripe", "title": "Solutions Architect", "school": "Waterloo", "industry": "fintech", "location": "Toronto", "notes": "Helped with our billing integration.", "tags": ["engineer"] },
    { "email": "claire@nea.example", "fullName": "Claire Dubois", "company": "NEA", "title": "Principal", "school": "Wharton", "industry": "venture capital", "location": "Washington DC", "notes": "Focused on healthcare AI startups.", "tags": ["investor"] },
    { "email": "sam@anthropic.example", "fullName": "Sam Whitfield", "company": "Anthropic", "title": "Applied AI Engineer", "school": "CMU", "industry": "ai", "location": "San Francisco", "notes": "Talked about agent evals at dinner.", "tags": ["engineer", "ai"] },
    { "email": "ines@shopify.example", "fullName": "Inés García", "company": "Shopify", "title": "Engineering Manager", "school": "Stanford", "industry": "commerce", "location": "Ottawa", "notes": "Manages checkout team. Stanford alum group organizer.", "tags": ["manager"] },
    { "email": "raj@coinbase.example", "fullName": "Raj Mehta", "company": "Coinbase", "title": "Security Engineer", "school": "UIUC", "industry": "crypto", "location": "Chicago", "notes": "Deep on key custody and wallet security.", "tags": ["engineer", "security"] },
    { "email": "amelia@nyt.example", "fullName": "Amelia Brooks", "company": "New York Times", "title": "Data Journalist", "school": "Columbia", "industry": "media", "location": "New York", "notes": "Covers tech policy. Intro'd me to two sources.", "tags": ["media"] },
    { "email": "kofi@flutterwave.example", "fullName": "Kofi Mensah", "company": "Flutterwave", "title": "Head of Partnerships", "school": "LSE", "industry": "fintech", "location": "Lagos", "notes": "Knows every payments operator in West Africa.", "tags": ["partnerships"] }
  ],
  "cases": [
    { "question": "Maya Chen", "expect": ["maya@stripe.example"], "kind": "exact-name" },
    { "question": "maya chenn", "expect": ["maya@stripe.example"], "kind": "typo" },
    { "question": "Tomas Riviera", "expect": ["tom@datadog.example"], "kind": "typo" },
    { "question": "who do I know at Stripe?", "expect": ["maya@stripe.example", "omar@stripe.example"], "kind": "attribute-company" },
    { "question": "fintech people in New York", "expect": ["dev@plaid.example", "prisha@ramp.example"], "kind": "attribute-multi" },
    { "question": "investors who focus on fintech", "expect": ["james@sequoia.example"], "kind": "attribute-tag" },
    { "question": "who went to Stanford?", "expect": ["maya@stripe.example", "ines@shopify.example"], "kind": "attribute-school" },
    { "question": "someone who can help me hire site reliability engineers", "expect": ["tom@datadog.example"], "kind": "semantic" },
    { "question": "who knows about payments infrastructure?", "expect": ["maya@stripe.example", "dev@plaid.example", "kofi@flutterwave.example"], "kind": "semantic" },
    { "question": "anyone working on recommender systems or ML?", "expect": ["erik@spotify.example", "sofia@openai.example", "sam@anthropic.example"], "kind": "semantic" },
    { "question": "who could review our security architecture?", "expect": ["raj@coinbase.example"], "kind": "semantic" },
    { "question": "a recruiter for senior engineering roles", "expect": ["hana@notion.example"], "kind": "semantic-tag" },
    { "question": "journalists covering technology", "expect": ["amelia@nyt.example"], "kind": "semantic" },
    { "question": "who mentors designers?", "expect": ["lena@figma.example"], "kind": "semantic" },
    { "question": "VCs investing in healthcare AI", "expect": ["claire@nea.example"], "kind": "attribute-multi" },
    { "question": "who did I meet at Money2020?", "expect": ["james@sequoia.example"], "kind": "notes-recall" }
  ]
}
```

Extend toward 30+ cases over time; keep the `kind` taxonomy (exact-name / typo / attribute-* / semantic / notes-recall) balanced.

- [ ] **Step 2: Write the harness**

Create `scripts/eval-retrieval.ts`:

```ts
/**
 * Retrieval accuracy eval: recall@12 and recall@60 over fixture questions.
 * Without an AI key: lexical arms only. With a key (GEMINI_API_KEY or
 * OPENAI_API_KEY in env, local only): + semantic arm and rerank stage.
 * Stop dev servers on .data/pglite first (PGlite is single-writer).
 * Run: npx tsx scripts/eval-retrieval.ts
 */
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
```

Note: `getQueryEmbedding`/`rebuildContactEmbeddingsBatch` resolve providers from user settings; with no `userSettings` row for the eval user they fall back to env keys (local dev allows env keys — `allowEnvProviderKeys`). If `rerankCandidates` fails for a missing completion key it degrades to RRF order by design, which the harness tolerates.

- [ ] **Step 3: Run the harness (lexical mode)**

Stop dev servers. Run: `npx tsx scripts/eval-retrieval.ts`
Expected: exit 0, a printed table, and lexical-mode recall@60 of 100% on exact-name/typo/attribute-company cases (semantic cases will miss without a key — that is expected and visible in the `kind` column).

- [ ] **Step 4: Run with a key if available**

If `GEMINI_API_KEY` or `OPENAI_API_KEY` is set locally: run again and record both recall numbers in the commit message body as the baseline.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval-retrieval.ts scripts/eval-fixtures/contact-search-eval.json
git commit -m "feat: retrieval accuracy eval harness (recall@12 / recall@60)"
```

---

### Task 12: Retire dead code + full verification

**Files:**
- Modify: `src/lib/search.ts` (delete `semanticSearchContacts`, `inMemorySemanticScores` if unreferenced)
- Modify: `src/lib/keyword-search.ts` (delete `mergeSearchHits` if unreferenced)
- Possibly modify: any remaining `semanticSearchContacts` callers

**Interfaces:**
- Consumes: everything above.
- Produces: a clean tree — no unused search paths, all gates green.

- [ ] **Step 1: Find remaining callers**

```bash
grep -rn "semanticSearchContacts\|mergeSearchHits\|inMemorySemanticScores" src/ --include='*.ts' --include='*.tsx'
```

For each caller found outside `src/lib/search.ts`/`src/lib/keyword-search.ts`: migrate it to `hybridSearchContacts` following the Task 5 adapter pattern (compute the query embedding via `getQueryEmbedding` when the call site has a userId and a natural-language query; otherwise lexical-only). If `semanticSearchContacts` has zero remaining callers, delete it and `inMemorySemanticScores`; same for `mergeSearchHits`. Keep `pgvectorSearchContacts` ONLY if something still calls it (Task 4's semantic arm has its own copy); delete if orphaned.

- [ ] **Step 2: Full smoke suite**

Stop dev servers, then:

```bash
npx tsx scripts/smoke-pgvector-local.ts
npx tsx scripts/smoke-trigram-search.ts
npx tsx scripts/smoke-embedding-cache.ts
npx tsx scripts/smoke-hybrid-search.ts
npx tsx scripts/smoke-dashboard-search.ts
npx tsx scripts/smoke-embedding-writes.ts
npx tsx scripts/smoke-fast-model.ts
npx tsx scripts/smoke-chat-retrieval.ts
npx tsx scripts/smoke-chat-pipeline.ts
npx tsx scripts/eval-retrieval.ts
```

All must exit 0.

- [ ] **Step 3: Repo gates**

```bash
npx tsc --noEmit
npm run lint 2>&1 | tail -5   # error count must be <= 48 (baseline)
npm run build
```

Also run the pre-existing smoke scripts most likely to be affected: `npx tsx scripts/smoke-contacts-page.ts` (contact list search path) and any `smoke-*` script whose name mentions search/contacts/chat (`ls scripts/smoke-*`).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: retire pre-hybrid search paths and verify all gates"
```

- [ ] **Step 5: Re-check origin/main before opening a PR**

Parallel worktrees have previously landed rival implementations mid-task:

```bash
git fetch origin && git log --oneline HEAD..origin/main -- src/lib/search.ts src/actions/search.ts src/actions/chat.ts src/lib/ai.ts src/db/index.ts
```

If anything touched these files on main, merge origin/main and re-run Step 2/3 before the PR.
