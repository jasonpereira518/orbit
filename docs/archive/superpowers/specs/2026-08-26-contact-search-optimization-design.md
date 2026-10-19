# Contact Search Optimization — Design

**Date:** 2026-08-26
**Status:** Approved (pending implementation plan)
**Scope:** LLM chat retrieval, dashboard ask-bar/graph search, contact list search, and upload-time storage/indexing. Admin contacts search is explicitly out of scope.

## Goals

1. **Accuracy first.** Chat answers should reliably surface the right contacts, including for attribute questions ("who at a fintech went to my school?") and typo'd names. Speed may be traded for accuracy within the latency budget below.
2. **Kill the full-table loads.** No search path may load or score the entire contact table in JS.
3. **One retrieval implementation.** Chat, ask-bar/graph, and (partially) the contact list share a single SQL-side hybrid search instead of three divergent code paths.

**Budgets:** chat answer ≤ ~10s end-to-end; keystroke (ask-bar) search DB time ≤ ~150ms; design target ~5–10k contacts per user. Intermediate LLM stages run on flash-tier models; only the final answer uses the user's chosen model (BYOK).

## Current state (summary)

- `contacts` has a weighted `search_tsv` (DDL-only, `src/db/index.ts:641`) with a GIN index, keyset pagination, and materialized closeness. A trigram index exists on `full_name`/`company` but is **dead**: predicates wrap columns in `lower()` and the index doesn't (`src/actions/contacts.ts:284`).
- `contact_embeddings` stores jsonb float arrays plus a runtime-managed `embedding_vector vector(1536)` column with an HNSW index (Neon only). Local PGlite currently always takes a JS cosine fallback.
- Chat (`askNetwork`, `src/actions/chat.ts:129`) is single-shot RAG: `semanticSearchContacts` (`src/lib/search.ts:171`) loads the **entire** contact table with tags, scores in JS, returns 12, serializes them unbounded into one prompt.
- Ask-bar/graph (`searchDashboardContacts`, `src/actions/search.ts:104`) does the same full-table load per keystroke; its embedding fallback materializes every vector with no limit or projection.
- Embedding writes are one round-trip per row (live rebuilds and cron backfill); imports re-embed contacts whose content didn't change.
- No AI SDK: raw vendor SDKs (`@anthropic-ai/sdk`, `@google/genai`, `openai`) dispatched by `completeJson` (`src/lib/ai.ts:416`), BYOK per user.

## 1. Retrieval core: `hybridSearchContacts()`

A single function (new module, e.g. `src/lib/hybrid-search.ts`) with the signature:

```ts
hybridSearchContacts(userId, {
  query: string,            // raw user text
  embedding?: number[],     // optional pre-computed query embedding
  filters?: SearchFilters,  // structured filters (see §2 stage 1)
  limit: number,            // candidate count to return
}): Promise<RankedContact[]>
```

It runs **one SQL query** with three arms, fused in the outer query:

- **Full-text arm:** `search_tsv @@ websearch_to_tsquery('simple', q)` ranked by `ts_rank_cd`. Uses the existing weighted A–D config and `contacts_search_gin`.
- **Fuzzy lexical arm:** trigram `similarity()` against `lower(full_name)` and `lower(company)` (threshold ~0.3), plus prefix `LIKE`. Requires the index fix in §3.
- **Semantic arm:** pgvector HNSW ANN over `contact_embeddings.embedding_vector`, keeping the existing inner-CTE `ORDER BY <=> LIMIT` shape (over-fetch ×4, dedupe per contact, similarity floor ~0.25). Skipped when no embedding is supplied.

**Fusion:** reciprocal-rank fusion (`score = Σ 1/(k + rank_arm)`, k=60) across whichever arms ran. RRF is rank-based, so the arms' incomparable score scales don't need calibration.

**Filters:** structured filters apply as WHERE clauses to all arms — company/industry/school/location as case-insensitive matches, tags via the existing `contact_tags` join, closeness tier as a range. **Recall guard:** if the filtered query returns fewer than `limit / 4` rows, re-run unfiltered and merge (filtered hits first) rather than returning a starved set.

**Fallback ladder for the semantic arm:**
1. pgvector (Neon prod, and PGlite dev via `@electric-sql/pglite/vector` — see §3).
2. Bounded JS cosine: project only `contact_id` + `embedding`, hard `LIMIT` (existing 2000-row cap), never materialize `content`. This replaces the current unbounded fallbacks; the one in `src/actions/search.ts:81` is deleted outright.

All existing callers of `semanticSearchContacts` and the dashboard's `loadContacts`/`rankKeywordSearch` path migrate to this function. `src/lib/keyword-search.ts` JS ranking is retired from server search paths (it may remain for any purely client-side filtering).

## 2. Chat pipeline (`askNetwork`)

Four stages. Stages 1 and the query-embedding call run **concurrently**.

**Stage 0 — embed (cached):** query-embedding LRU (§5); on miss, one `createEmbedding` call.

**Stage 1 — query understanding (flash-tier, ~1s):** one `completeJson` call parsing the question into:

```ts
{ semanticQuery: string,        // rewritten retrieval-friendly query
  filters: { companies?, industries?, schools?, locations?, tags?, closenessTier? },
  expansionTerms?: string[] }   // synonyms/aliases folded into the lexical arms
```

Self-references ("my school", "my company") resolve against the user's profile, which is passed into the prompt. On parse failure or timeout (~2.5s), fall through with `semanticQuery = raw question` and no filters — this stage may only add accuracy, never block the pipeline.

**Stage 2 — wide retrieval:** `hybridSearchContacts` with `limit ≈ 60` and the parsed filters. Embedding computed from `semanticQuery` when it differs materially from the raw question is *not* done — the raw-question embedding from stage 0 is used to keep the stages parallel.

**Stage 3 — LLM rerank (flash-tier, ~2s):** the ~60 candidates rendered as compact cards (name, title, company, school, one-line summary, the matched snippet from retrieval). One `completeJson` call returns `{ id, relevance: 0–10 }[]`. Keep the top 12 with relevance ≥ 3; if fewer than 3 survive, keep the top 5 by rerank score regardless. On rerank failure, fall back to RRF order (top 12) — again, accuracy-only stage, never blocking.

**Stage 4 — answer (user's chosen model):** existing JSON answer contract and post-hoc contact-ID hallucination filter (`src/actions/chat.ts:282`) are unchanged. Contact serialization gains a **token budget**: total context cap (~12k tokens estimated at 4 chars/token) with per-contact caps allocated by rerank score — top-ranked contacts get fuller notes and more message snippets than today's fixed 400 chars/6 snippets; lower-ranked ones get compact cards. Serialization stops when the budget is exhausted.

**Latency accounting:** stage 0+1 concurrent ≈ 1–2.5s, stage 2 < 150ms, stage 3 ≈ 2s, stage 4 ≈ 3–5s → ~7–9s worst case, within the 10s budget.

## 3. Ingestion / upload-time changes

- **Content-hash skip:** add `content_hash text` to `contact_embeddings`. `rebuildContactEmbedding`/`rebuildContactEmbeddingsBatch` compute the hash of the built content first and skip the embedding API call and write when unchanged. Bulk imports that touch thousands of unchanged contacts become near-no-ops.
- **Batched writes:** embedding rows written via multi-row upsert; the `embedding_vector` copy becomes one set-based `UPDATE contact_embeddings SET embedding_vector = v.vec FROM (VALUES …) v WHERE id = v.id` per batch. Applies to live rebuilds (`src/lib/search.ts:449`) and the cron backfill (`src/db/index.ts:1185`).
- **Embedding content audit:** keep per-source rows (`sourceType`/`sourceId`), but verify `buildContactEmbeddingContent` (`src/lib/search.ts:342`) chunks profile facts, notes, and message threads into separately retrievable rows instead of one truncated 8k blob. Split oversized sources.
- **Index fixes (DDL sweep, guarded by `SCHEMA_VERSION` bump):**
  - Recreate `contacts_name_trgm` as `gin(lower(full_name) gin_trgm_ops, lower(company) gin_trgm_ops)` so the planner can use it for the `lower()`-wrapped predicates.
  - Audit other expression/predicate mismatches encountered during implementation.
- **PGlite vector extension:** wire `@electric-sql/pglite/vector` into the PGlite constructor (alongside the existing `pg_trgm`), letting the runtime `CREATE EXTENSION vector` + HNSW path succeed locally. Correct the in-code comment claiming pgvector has no PGlite build. If the extension proves broken in practice, the bounded JS fallback (§1) remains and dev parity is documented as a known gap.
  - **PGlite single-writer caution:** any migration/backfill script must not run while a dev server holds the PGlite lock (known corruption hazard).

## 4. Ask-bar / graph + contact list

- **Ask-bar & graph** (`searchDashboardContacts`): reimplemented on `hybridSearchContacts`. No rerank, no query-understanding stage — this is a keystroke path. Queries of 1–2 tokens run lexical-only (no embedding call at all); longer queries include the semantic arm only when the embedding is already in cache or resolves within a short timeout (~300ms), otherwise lexical results return immediately. The 180ms client debounce stays.
- **Contact list** (`searchCondition`, `src/actions/contacts.ts:284`): keeps its shape (tsvector + prefix + tags) and gains a trigram-similarity branch backed by the fixed index, delivering the typo tolerance the doc comment already promises. Keyset pagination untouched.

## 5. Caching

In-memory LRU for query embeddings: key = SHA-256 of `provider + model + normalized(query)`, value = vector, ~1h TTL, ~500 entries. Module-level singleton (same pattern as `globalForDb`), effective because Fluid Compute reuses instances. No external cache infrastructure. DB-side search results are not cached — the queries are fast and contacts change frequently.

## 6. Error handling summary

- Query understanding and rerank are **accuracy-only stages**: on failure/timeout they degrade to pass-through (raw query, RRF order) and the pipeline continues. Failures are logged, never surfaced as chat errors.
- The semantic arm degrades down the fallback ladder (§1); lexical arms have no external dependency.
- The recall guard (§1) prevents over-filtering from returning empty sets.
- The existing hallucination filter on answer contact IDs stays as the last line.

## 7. Testing & accuracy evaluation

- **Fusion-query integration tests** against PGlite (with vector extension): seeded fixtures asserting each arm contributes — a typo'd name found via trigram, an attribute filter narrowing correctly, a semantic paraphrase match, and RRF ordering sane when arms disagree.
- **Retrieval eval harness** (script, e.g. `scripts/eval-retrieval.ts`): ~30–50 question → expected-contact fixtures over a seeded network. Reports recall@12, recall@60 (pre-rerank), and precision@12 (post-rerank when run with API keys). Run before/after to prove the accuracy claim with a number. Follows the repo's script conventions (explicit `process.exit(0)`, never against a live dev server's PGlite).
- **Regression gates:** `tsc --noEmit` clean, build passes (baseline is green), eslint at or below the 48-error baseline, existing smoke scripts pass.

## Out of scope

- Admin contacts search (`src/lib/admin-user-detail.ts:817`).
- Tool-calling/agentic chat (revisit if pipeline accuracy proves insufficient on multi-hop questions).
- External search infrastructure (Typesense/Upstash/etc.).
- Embedding model upgrades (e.g. `text-embedding-3-large`) — orthogonal; the pipeline works with either.
