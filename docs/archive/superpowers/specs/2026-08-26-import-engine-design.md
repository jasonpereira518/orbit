# Import engine: one resumable, batched pipeline for every importer

**Date:** 2026-08-26
**Status:** Approved design, not yet implemented

## Problem

Orbit runs on `neon-http` (`src/db/index.ts`), where every Drizzle statement is a
separate HTTPS request with no pipelining and no transactions. Round-trip count *is*
runtime. The import paths spend round trips per *row* rather than per *chunk*, and
three of the five importers have no resumability at all.

Measured against the current code:

### LinkedIn connections — `src/lib/import-job-processor.ts`

The only importer with job rows, self-continuation, and a cron backstop. Still leaky:

- `rebuildContactEmbeddingsBatch` ends in a sequential loop calling
  `persistEmbeddingVector` — one round trip per contact (`src/lib/search.ts:451`),
  plus two per updated row. ~40–80 round trips per 40-row chunk; the single largest cost.
- The duplicate-merge branch calls `updateContact` per row, and `updateContactForUser`
  calls the *uncached* `companyFieldsForWrite` (`src/lib/contact-writes.ts:434`) —
  discarding the preloaded `companyResolve` and spending 2–3 round trips per merged row.
- Every invocation, including each self-continuation, reloads all of the user's contacts
  with all columns to rebuild the duplicate index (`import-job-processor.ts:95`), dragging
  every `notes` / `aiSummary` / `keyFacts` blob across the wire.
- `CHUNK_SIZE = 40` multiplies fixed per-chunk costs across 75 iterations for a 3,000-row
  export.
- One embedding API call per chunk sits blocking in the middle of the loop.

### Google / Outlook contacts — `src/actions/imports.ts:1161`, `:1324`

Worse, and not on that pipeline at all. One synchronous server action, per-row
`createContactIfRoom`: headroom `count(*)` + company resolve + insert + tag sync + a
**separate embedding API call per contact** + rescore ≈ 12–20 round trips each. Uses the
unindexed `findDuplicateCandidates` over a growing array, so duplicate detection is O(n²)
with Levenshtein. No job rows, no time budget, no resume — a large mailbox hits the 300s
ceiling and dies leaving nothing recoverable.

### LinkedIn messages / calendar

Client-driven with `IMPORT_BATCH_SIZE = 8` (`src/components/imports/import-utils.tsx:16`).
The **entire CSV is re-uploaded and re-parsed on every batch of 8**, and all contacts are
re-fetched each time. Per-row writes as above.

## Decisions taken

Settled during design; recorded so the plan does not relitigate them.

| Decision | Choice | Why |
|---|---|---|
| Scope | Staged: batch the existing LinkedIn hot spots, then unify all importers | Ships value early, ends with one engine |
| Embeddings | Deferred to a backfill, off the import's critical path | Removes the blocking AI call; import can no longer fail on a flaky provider |
| Target scale | 1k–5k rows | A tightly batched serial worker suffices; **no sharded workers** |
| Phase 3 shape | Generic row-payload engine with per-type adapters | Deletes the per-row loops outright; every importer inherits resume, progress, plan caps, cancellation |

Explicitly out of scope, with reasons: sharded parallel workers (unnecessary at this
scale), switching the runner to a pooled/WebSocket Neon connection (batching removes the
need; keeps the driver story uniform), and durable queue infrastructure such as Vercel
Queues or Workflow (overkill at 5k rows, adds a platform dependency the existing
self-continuation plus cron backstop already covers).

**Delivery order matters.** Phase 2 lands before Phase 3 because the engine sets
`embedding_stale_at`, which Phase 2 introduces. Phase 1 still batches
`persistEmbeddingVector` even though Phase 2 later moves embedding *generation* off the
critical path — Phase 1 is a standalone win while embeddings are still inline, and the
batched vector write survives into the backfill runner. Each phase is independently
shippable and independently revertible.

## Phase 1 — Batch the existing LinkedIn pipeline

Five changes inside `import-job-processor.ts` and its callees. None change behavior; all
survive into Phase 2.

1. Collapse `persistEmbeddingVector`'s per-row loop into one `UPDATE … FROM (VALUES …)`,
   the same construction `markRowsDone` already uses. ~40–80 round trips per chunk → 1.
2. Replace the per-row `updateContact` merge loop with a single bulk-merge statement that
   resolves company ids through the already-preloaded `companyResolve`. ~120 → 1.
3. Select only the six columns `buildDuplicateIndex` reads instead of every contact column.
4. Hoist the plan-headroom `count(*)` out of the chunk loop: count once, decrement in memory.
5. Raise `CHUNK_SIZE` 40 → 250 and issue the independent end-of-chunk writes concurrently.

## Phase 2 — Deferred embedding backfill

The work list must cover both contacts never embedded and contacts whose embedded text
went stale after a merge. A `LEFT JOIN contact_embeddings` derivation catches only the
first, so staleness is marked explicitly.

**Schema:** `contacts.embedding_stale_at timestamptz`, partial index
`WHERE embedding_stale_at IS NOT NULL`. It is set inside the bulk INSERT and bulk UPDATE
Phase 1 already issues — zero extra statements — and Phase 3's engine inherits that. The
LinkedIn processor stops calling `rebuildContactEmbeddingsBatch` in the loop and sets the
flag instead; this is the one behavioral change in the phase, and it is the point of it.

Step 3 below needs a unique index on `contact_embeddings (user_id, contact_id,
source_type, source_id)` that does not exist today — only non-unique indexes on `user_id`
and `contact_id` (`src/db/schema.ts:828`). The migration must dedupe existing rows before
creating it, keeping the newest per key.

`source_id` is part of that key, and dropping it would be destructive rather than merely
imprecise. `upsertContactEmbedding` keys its own existence check on all four columns, and
`src/lib/calendar-sync.ts` writes one `"meeting"` row per meeting with a distinct
`source_id` — so a three-column key makes the migration's dedupe delete every meeting
embedding except the newest per contact, and then makes each subsequent meeting write raise
a unique violation that `upsertContactEmbedding`'s blanket `catch {}` swallows. `source_id`
is nullable and Postgres indexes NULLs as distinct, so rows written without one stay
unconstrained; that matches the writer, which skips its existence check when no `source_id`
is supplied.

**Runner** (`src/lib/embedding-backfill.ts`), time-boxed. It is **not** self-continuing on
its own: it stops at its time budget and returns `remaining`, and the loop lives in
`POST /api/embeddings/backfill`, which re-kicks itself while `remaining > 0` — the same
division of labour as the import engine's `scheduleContinuation`. A caller that ignores
`remaining` strands the rest of the backlog until the daily cron notices it. The daily cron
must therefore also bound its own sweep by wall clock rather than by user count: a fixed
number of users each free to take the runner's full internal budget overruns the route's
300s `maxDuration`, which kills the function before `finishCronRun` can record the run.

1. Claim up to 500 stale contacts for a user — 1 statement
2. Build embedding content locally; one `createEmbeddingsBatch` per ~200 texts
3. One `INSERT … ON CONFLICT DO UPDATE` for the embedding rows, writing `embedding_vector`
   in the same statement — this deletes `persistEmbeddingVector`'s per-row loop rather
   than working around it
4. Clear `embedding_stale_at` — 1 statement
5. A second phase does the same for `'meeting'` embeddings. Moving calendar onto the engine
   removed the per-meeting `upsertContactEmbedding` call the old importer made, and
   `src/actions/search.ts` reads every source type — so without this, meeting content
   stops being semantically searchable. It is drained here rather than restored per row
   for the same reason profiles are: a per-row provider round trip is the cost this whole
   design exists to remove. Pending work is a query (`interactions` rows with no matching
   `contact_embeddings` row), not a flag, so there is no new column to keep in sync.

**Trigger:** the import job kicks `/api/embeddings/backfill` on completion, using the same
`after()` + `CRON_SECRET` pattern as `src/app/api/imports/[id]/continue/route.ts`. The
daily cron **cannot** be the primary path: `0 0 * * *` is the Hobby-plan minimum, so
relying on it would leave imported contacts unsearchable for up to 24 hours. Cron is a
backstop only.

Fixing the per-row loop inside `rebuildContactEmbeddingsBatch` benefits its other callers,
so it is worth doing even though the import path stops calling it.

**Accepted trade-off:** newly imported contacts are absent from semantic search and chat
until the backfill completes — expected to be seconds, bounded by the cron at worst.

## Phase 3 — The engine

### Adapter interface

New `src/lib/import-engine.ts` owns the loop. Import types contribute pure functions only:

```ts
type ImportAdapter<P> = {
  /** Fields the duplicate index probes. null → row unusable, mark skipped. */
  identity(payload: P): DuplicateProbe | null;
  /** Contact to insert when nothing matches confidently. */
  toCreate(payload: P): ContactInput;
  /** Column patch when a >= DUPLICATE_MERGE_CONFIDENCE duplicate matches. */
  toMerge(payload: P, matched: DuplicateSubject): Partial<ContactInput>;
  /** Opt out of the create path entirely (calendar). Defaults to true. */
  createsContacts?: boolean;
  /** Rows to bulk-insert into `interactions` (messages, calendar). */
  interactions?(payload: P, contactId: string): InteractionRow[];
};
```

`DuplicateProbe` is the existing incoming-row shape `findDuplicateCandidatesIndexed`
already accepts; `DuplicateSubject` is the narrowed contact row introduced below;
`InteractionRow` is the insert shape for `interactions`. Adapters live in
`src/lib/import-adapters/`, registered by `importType`. Dispatch goes
through the existing `runImportJobById` (`src/lib/import-job-dispatch.ts:34`), which was
already written for this shape.

### Per-chunk statement budget

| Step | Statements |
|---|---|
| Re-read job status | 1 |
| Claim next chunk (`UPDATE … RETURNING`, see Resume) | 1 |
| Adapter classifies create / merge / skip | 0 — pure, in memory |
| Bulk create: `insert … returning` + tag resolve + `contact_tags` | 3–4 |
| Bulk merge: one `UPDATE contacts … FROM (VALUES …)` | 1 |
| Bulk insert interactions (only if the adapter supplies them) | 0–1 |
| Mark rows done / skipped / plan-blocked | 3, issued concurrently |
| Flag touched contacts embedding-stale | 0 — set in the statements above |
| Progress update on `imports` | 1 |

**~10 round trips per chunk, independent of chunk size.** At `CHUNK_SIZE = 250`, a
5,000-row import is 20 chunks ≈ 200 round trips ≈ 7s of DB time, against roughly 7,000
today.

### Two deliberate consequences

**`DuplicateIndex` narrows its row type.** It reads only `id, fullName, email,
linkedinUrl, company, title` but is typed on the full `Contact`. Introduce
`DuplicateSubject` and select those six columns; `duplicates.ts` and its callers change
with it.

**A second contact-write path now exists.** The engine writes contacts in bulk rather than
through `createContactForUser` / `updateContactForUser`, which remain for interactive
edits. `contactInsertValues` stays the shared column mapping for creates, but the bulk
merge and `updateContactForUser`'s column list must be kept in sync by hand. This is a
real, ongoing maintenance cost, accepted knowingly: routing bulk writes through the
per-row functions is exactly what is slow today. The bulk merge carries a comment naming
`updateContactForUser` as its counterpart.

### Preserved invariants

Plan-cap headroom is counted once at job start, decremented in memory, and re-verified on
each continuation. Overflow rows still land `skipped` with `PLAN_LIMIT_ROW_REASON` and
count into `stats.blockedByPlan`. Per-row closeness scoring stays skipped;
`recalibrateCloseness` runs exactly once, at job end. The revalidation set is unchanged,
including the `PER_CONTACT_REVALIDATE_LIMIT` guard.

### Per-importer migration

| Type | Change |
|---|---|
| `linkedin_connections` | Logic moves verbatim into an adapter. Behavior-identical — the control that proves the engine. |
| `google_contacts`, `outlook_contacts` | The server action fetches the People / Graph API once, snapshots selected people into `import_job_rows`, kicks the job, returns immediately. Per-row loops at `imports.ts:1179` and `:1342` are deleted. UI moves to the poll-based watcher LinkedIn already uses. |
| `linkedin_messages` | Adapter supplies `interactions()` for one bulk insert. Ingest parses the CSV once, server-side, one job row per conversation — killing the re-upload-per-8-conversations behavior in `import-job-runner.ts:170`. |
| `calendar_ics`, `calendar_csv` | `createsContacts: false` — matches existing people only, logs meetings and follow-ups through `interactions()`. Engine skips the create and plan-cap branches. |

Order: LinkedIn, then Google/Outlook, then messages, then calendar. Each is independently
shippable and independently revertible.

## Failure, resume, cancellation

**Row failures.** Today any thrown row fails the entire import. At 250-row statements that
is far too blunt. On a chunk write failure the engine halves the chunk and retries, down
to single rows; rows that genuinely fail are marked `failed` with their message
(`import_job_rows` already has `status` and `errorMessage`) and the job continues.

**Resume.** Rows are the source of truth and statuses are terminal, so re-running is
idempotent — except that `neon-http` has no transactions, so a crash between "insert
contacts" and "mark rows done" leaves rows `pending` that would be re-created on resume.
This hazard exists today at 40-row granularity; at 250 it is worth fixing. Claim before
writing, replacing the pending-rows `SELECT`:

```sql
UPDATE import_job_rows SET status = 'processing'
WHERE id IN (SELECT id FROM import_job_rows
             WHERE import_id = $1 AND status = 'pending'
             ORDER BY row_index LIMIT $2)
RETURNING *
```

One statement replacing one read — net zero cost. On resume, leftover `processing` rows go
back through the duplicate index, which now matches the contact that was created and
merges instead of duplicating. Self-healing for any row with a strong identity key
(LinkedIn URL, email). A name-only row could still duplicate: strictly better than today,
and stated rather than papered over. The claim primitive also makes parallel workers
possible later without a schema change.

**Cancellation** latency rises to one chunk. Mitigated by re-checking job status once
mid-chunk, before the write phase.

## Schema changes

One column and one partial index appended to the migrations array in `src/db/index.ts`,
plus a matching idempotent `scripts/migrate-embedding-stale.ts` following the existing
`scripts/migrate-*.ts` convention. `SCHEMA_VERSION` 6 → 7, and `scripts/schema-ddl.lock.json`
regenerated.

**Never `npm run db:push`** — drizzle push drops the runtime-managed `embedding_vector`
column.

A unique index on `contact_embeddings (user_id, contact_id, source_type)`, preceded by a
dedupe of existing rows (keep newest per key), lands with Phase 2 — the backfill's
`ON CONFLICT DO UPDATE` depends on it.

New payload kinds (`google_contact`, `outlook_contact`, `linkedin_message_thread`,
`calendar_event`) join the `ImportJobRowPayload` union in `src/db/schema.ts`. Rows written
without a `kind` already mean LinkedIn and stay valid.

## Verification

Two scripts under `scripts/`, following the existing `smoke-*.ts` convention:

1. **`smoke-import-engine.ts`** — seeds a user and runs each importer end-to-end against
   PGlite, asserting `created / updated / skipped / blockedByPlan` counts. The baseline is
   captured by running it against the **current** code first, so each migration is proven
   behavior-identical rather than merely plausible.
2. **A statement-count guard** — wraps the db in a counting proxy and asserts round trips
   per chunk stay within budget. This is the regression that matters: a single
   re-introduced per-row `await` is precisely how this got slow, and nothing currently
   catches it.

Both write to the database, so the worktree dev server must be stopped first — PGlite is
single-writer and concurrent writers corrupt `.data/pglite` unrecoverably.

Existing smoke suites must continue to pass. `tsc` must exit 0; ESLint must not increase the existing
error count.

## Instrumentation

There is currently no record of how long an import took. Wall-clock duration and statement
count go into `imports.stats`, so "is it actually faster in production" has an answer.

## Expected outcome

A 5,000-row LinkedIn import goes from roughly 7,000 round trips and ~125 blocking AI calls
to roughly 200 round trips and zero blocking AI calls. Google and Outlook imports go from
timing out with nothing recoverable to the same resumable path.
