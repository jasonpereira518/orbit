# Import Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Orbit's imports finish in seconds instead of minutes (or timing out) by spending database round trips per *chunk* rather than per *row*, moving embedding generation off the critical path, and putting every importer on one resumable engine.

**Architecture:** Orbit runs on `neon-http`, where each Drizzle statement is a separate HTTPS request — round-trip count *is* runtime. Phase 1 collapses the per-row loops in the existing LinkedIn processor into single `... FROM (VALUES ...)` statements. Phase 2 replaces inline embedding generation with an `embedding_stale_at` flag plus a batched backfill runner. Phase 3 generalizes the row-payload processor into an engine that every importer feeds through a small pure adapter.

**Tech Stack:** Next.js App Router (see `AGENTS.md` — read `node_modules/next/dist/docs/` before writing route or server-action code), Drizzle ORM, `neon-http` in production / PGlite locally, TypeScript, standalone `tsx` smoke scripts.

**Spec:** `docs/superpowers/specs/2026-08-26-import-engine-design.md` — read it before starting. Every task argues from it.

## Global Constraints

- **Never run `npm run db:push`.** Drizzle push drops the runtime-managed `contact_embeddings.embedding_vector` column and its HNSW index. All DDL goes through the arrays in `src/db/index.ts` plus an idempotent `scripts/migrate-*.ts`.
- **Any DDL change requires bumping `SCHEMA_VERSION`** (`src/db/index.ts:590`) and regenerating the lock: `npx tsx scripts/smoke-schema-ddl.ts --update`. `getDb()` skips the entire migration sweep when the recorded version matches, so unbumped DDL never runs on an already-migrated database.
- **PGlite is single-writer.** Stop this worktree's dev server before running any script that writes. Concurrent writers corrupt `.data/pglite` unrecoverably.
- **Smoke scripts must call `process.exit(0)` explicitly** on success — the pooled connection keeps the event loop alive and the script hangs otherwise.
- **No test framework.** Tests are `scripts/smoke-*.ts` run with `npx tsx`, using the local `check(label, condition, detail?)` helper pattern from `scripts/smoke-entitlements.ts`.
- **Verification gate for every commit:** `npx tsc --noEmit` exits 0, and `npm run lint` does not increase the existing error count. Note: a worktree has no `node_modules` of its own — symlink the main checkout's, or `tsc`/`eslint` silently no-op and exit 0.
- **Behavior is frozen.** Every phase must leave `created / updated / skipped / blockedByPlan` counts identical for the same input. Task 1 exists to prove that.
- Preserved invariants throughout: plan-cap headroom admits from the front and marks overflow rows `skipped` with `PLAN_LIMIT_ROW_REASON`; per-row closeness scoring stays skipped; `recalibrateCloseness` runs exactly once at job end; the `PER_CONTACT_REVALIDATE_LIMIT` guard stays.

## File Structure

**Created**
- `scripts/smoke-import-engine.ts` — behavior characterization: counts per importer, frozen across all three phases
- `scripts/smoke-import-perf.ts` — round-trip budget guard; the regression that actually matters
- `src/lib/query-counter.ts` — process-local statement counter fed by a Drizzle logger
- `src/lib/embedding-backfill.ts` — claims stale contacts, embeds in batches, writes vectors in one statement
- `src/app/api/embeddings/backfill/route.ts` — kick target, `CRON_SECRET`-authorized
- `scripts/migrate-embedding-stale.ts` — idempotent DDL for the flag and the unique index
- `src/lib/import-engine.ts` — the generic chunk loop
- `src/lib/import-adapters/{index,linkedin-connections,google-contacts,outlook-contacts,linkedin-messages,calendar}.ts` — pure per-type functions

**Modified**
- `src/lib/search.ts` — batch the vector write (`persistEmbeddingVector`'s loop, line 451)
- `src/lib/contact-writes.ts` — add `bulkMergeContactsForUser`; set `embedding_stale_at` in bulk writes
- `src/lib/duplicates.ts` — narrow `Contact` to `DuplicateSubject`
- `src/lib/import-job-processor.ts` — Phase 1 batching, then reduced to a thin adapter caller
- `src/lib/import-job-dispatch.ts` — route each `importType` to the engine as its adapter lands
- `src/db/index.ts` — Drizzle `logger` wiring, DDL, `SCHEMA_VERSION` 6 to 7
- `src/db/schema.ts` — `embedding_stale_at`; new `ImportJobRowPayload` kinds
- `src/actions/imports.ts` — ingest rewrites; per-row loops deleted
- `src/components/imports/*` — Google/Outlook/messages/calendar move to the poll-based watcher

---

## Phase 1 — Batch the existing LinkedIn pipeline

### Task 1: Freeze current import behavior with a characterization test

This test must **pass against the code as it exists today**. It is the contract every later task is measured against, so write it first and do not change it afterward without saying so out loud.

**Files:**
- Create: `scripts/smoke-import-engine.ts`

**Interfaces:**
- Produces: local helpers `fixture(n, dupEvery?)`, `seedJob(rows)`, `outcome(importId)` reused by Tasks 11–15.

- [ ] **Step 1: Write the characterization test**

Model the structure on `scripts/smoke-entitlements.ts` (dotenv preamble, `check()`, `reset()`, explicit exit).

```ts
/**
 * Freezes import outcomes across the engine rewrite.
 *
 * Every phase of the import work is allowed to change how many round trips an import
 * costs; none of it is allowed to change how many contacts an import creates, merges,
 * or refuses. This asserts the second thing so the first is safe to change.
 *
 * Run: npx tsx scripts/smoke-import-engine.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, imports, importJobRows, userSettings } from "../src/db/schema";
import { runLinkedInImportJob } from "../src/lib/import-job-processor";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-import-engine-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

/** Deterministic rows. With `dupEvery > 0`, every Nth row repeats an earlier row's identity. */
function fixture(n: number, dupEvery = 0) {
  return Array.from({ length: n }, (_, i) => {
    const src = dupEvery > 0 && i > 0 && i % dupEvery === 0 ? i - dupEvery : i;
    return {
      index: i,
      firstName: `First${src}`,
      lastName: `Last${src}`,
      email: `person${src}@example.com`,
      company: `Company ${src % 17}`,
      position: `Title ${src % 11}`,
      connectedOn: "15 Mar 2024",
      url: `https://www.linkedin.com/in/person-${src}`,
    };
  });
}

/** Seeds an import plus its job rows directly, skipping CSV parsing. */
async function seedJob(rows: ReturnType<typeof fixture>) {
  const db = await getDb();
  const [job] = await db
    .insert(imports)
    .values({
      userId: USER,
      importType: "linkedin_connections",
      fileName: "fixture.csv",
      status: "processing",
      totalRows: rows.length,
      stats: {},
    })
    .returning();
  await db.insert(importJobRows).values(
    rows.map((payload, i) => ({
      importId: job.id,
      userId: USER,
      rowIndex: i,
      payload,
    }))
  );
  return job.id;
}

async function outcome(importId: string) {
  const db = await getDb();
  const row = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  if (!row) throw new Error("import row vanished");
  return {
    status: row.status,
    created: row.contactsCreated ?? 0,
    updated: row.contactsUpdated ?? 0,
    skipped: row.stats?.skipped ?? 0,
    blockedByPlan: row.stats?.blockedByPlan ?? 0,
  };
}

async function main() {
  console.log("Import behavior characterization (pglite)...");

  // --- all new rows ---
  await reset();
  let id = await seedJob(fixture(120));
  await runLinkedInImportJob(id);
  let out = await outcome(id);
  check("120 fresh rows complete", out.status === "completed", JSON.stringify(out));
  check("120 fresh rows all created", out.created === 120, JSON.stringify(out));
  check("120 fresh rows none merged", out.updated === 0, JSON.stringify(out));

  // --- re-importing the same file merges instead of duplicating ---
  id = await seedJob(fixture(120));
  await runLinkedInImportJob(id);
  out = await outcome(id);
  check("re-import merges all", out.updated === 120, JSON.stringify(out));
  check("re-import creates none", out.created === 0, JSON.stringify(out));

  // --- rows with no usable name are skipped, not failed ---
  await reset();
  const withBlank = fixture(10);
  withBlank[3].firstName = "";
  withBlank[3].lastName = "";
  id = await seedJob(withBlank);
  await runLinkedInImportJob(id);
  out = await outcome(id);
  check("blank name skipped", out.skipped === 1, JSON.stringify(out));
  check("remaining rows created", out.created === 9, JSON.stringify(out));

  // --- the free plan cap admits from the front and refuses the rest ---
  await reset();
  id = await seedJob(fixture(140));
  await runLinkedInImportJob(id);
  out = await outcome(id);
  check("free cap admits 100", out.created === 100, JSON.stringify(out));
  check("free cap blocks the rest", out.blockedByPlan === 40, JSON.stringify(out));
  check("capped import still completes", out.status === "completed", JSON.stringify(out));

  // --- resume is idempotent: a second run adds nothing ---
  const before = out.created;
  await runLinkedInImportJob(id);
  const again = await outcome(id);
  check("re-running a finished job is a no-op", again.created === before, JSON.stringify(again));

  await reset();
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  console.log("\nAll import behavior checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
```

- [ ] **Step 2: Stop the dev server, then run it**

```bash
npx tsx scripts/smoke-import-engine.ts
```

Expected: every check prints `ok`. **If a check fails, the assertion is wrong, not the code** — this task's whole job is to describe what the current implementation already does. Fix the expectation and re-run. The free-plan cap value comes from `FREE_CONTACT_LIMIT` in `src/lib/entitlements.ts`; if it is not 100, adjust both cap assertions to match it.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-import-engine.ts
git commit -m "test: characterize current import outcomes before the engine rewrite"
```

---

### Task 2: Count statements, and assert a budget the current code fails

**Files:**
- Create: `src/lib/query-counter.ts`
- Create: `scripts/smoke-import-perf.ts`
- Modify: `src/db/index.ts:1462-1472`
- Modify: `src/lib/import-job-processor.ts` (export `CHUNK_SIZE`)

**Interfaces:**
- Produces: `startQueryCount(): void`, `stopQueryCount(): number`, `noteQuery(): void` from `src/lib/query-counter.ts`. Task 6 reuses these to record statement counts in `imports.stats`.

- [ ] **Step 1: Write the counter**

```ts
/**
 * Process-local count of SQL statements issued.
 *
 * On `neon-http` every statement is a separate HTTPS request, so this number is the
 * closest thing Orbit has to a wall-clock predictor for bulk work — and the only way to
 * catch a re-introduced per-row `await`, which is how the import path got slow in the
 * first place. Deliberately an exact counter and not a sampler: the guard asserts a
 * budget, and an approximate number would be worse than none.
 */
let active = false;
let count = 0;

export function startQueryCount() {
  active = true;
  count = 0;
}

export function stopQueryCount() {
  active = false;
  return count;
}

/** Called by the Drizzle logger wired up in `src/db/index.ts`. */
export function noteQuery() {
  if (active) count += 1;
}
```

- [ ] **Step 2: Wire it into all three Drizzle constructions**

In `src/db/index.ts`, add near the top:

```ts
import { noteQuery } from "@/lib/query-counter";

/**
 * Drizzle's logger hook is the only place every statement funnels through regardless of
 * driver, which is why the statement counter hangs off it rather than off `db.execute`.
 * It logs nothing — `logQuery` is used purely as a per-statement callback.
 */
const countingLogger = { logQuery: () => noteQuery() };
```

Then replace `{ schema }` with `{ schema, logger: countingLogger }` in each of the three constructions at lines 1462, 1469, and 1470.

- [ ] **Step 3: Export `CHUNK_SIZE` so the guard derives its budget**

In `src/lib/import-job-processor.ts`, change `const CHUNK_SIZE = 40;` to `export const CHUNK_SIZE = 40;`.

- [ ] **Step 4: Write the budget guard**

```ts
/**
 * Guards the round-trip cost of a bulk import.
 *
 * The import path is fast only as long as its statements are per-chunk, not per-row. That
 * property is invisible in behavior — a per-row `await` in a loop returns exactly the same
 * contacts, just fifty times slower — so nothing but a count can defend it.
 *
 * Run: npx tsx scripts/smoke-import-perf.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, imports, importJobRows, userSettings } from "../src/db/schema";
import { CHUNK_SIZE, runLinkedInImportJob } from "../src/lib/import-job-processor";
import { startQueryCount, stopQueryCount } from "../src/lib/query-counter";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-import-perf-user";
const ROWS = 500;

/**
 * Statements a chunk may cost, end to end. Derived from the spec's budget table (~10) with
 * headroom for driver-level chatter. Raising this number is a design decision, not a test
 * fix — if a change needs more, say why in the commit message.
 */
const BUDGET_PER_CHUNK = 14;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  console.log("Import round-trip budget (pglite)...");

  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await ensureUserSettings(USER);
  // The free cap would refuse most of the fixture and the import would end early, measuring
  // nothing. Comp the user to pro so the whole fixture is processed.
  await db
    .update(userSettings)
    .set({ compedPlan: "pro" })
    .where(eq(userSettings.userId, USER));

  const [job] = await db
    .insert(imports)
    .values({
      userId: USER,
      importType: "linkedin_connections",
      fileName: "perf.csv",
      status: "processing",
      totalRows: ROWS,
      stats: {},
    })
    .returning();

  await db.insert(importJobRows).values(
    Array.from({ length: ROWS }, (_, i) => ({
      importId: job.id,
      userId: USER,
      rowIndex: i,
      payload: {
        index: i,
        firstName: `Perf${i}`,
        lastName: `Person${i}`,
        email: `perf${i}@example.com`,
        company: `Company ${i % 30}`,
        position: `Title ${i % 12}`,
        connectedOn: "15 Mar 2024",
        url: `https://www.linkedin.com/in/perf-person-${i}`,
      },
    }))
  );

  startQueryCount();
  await runLinkedInImportJob(job.id);
  const used = stopQueryCount();

  const chunks = Math.ceil(ROWS / CHUNK_SIZE);
  // Job-level setup (contact load, company preload, final recalibration) is not per-chunk,
  // so it gets its own small allowance rather than inflating the per-chunk budget.
  const allowed = chunks * BUDGET_PER_CHUNK + 20;

  console.log(`  ${used} statements for ${ROWS} rows in ${chunks} chunk(s); budget ${allowed}`);
  check(
    "import stays within its round-trip budget",
    used <= allowed,
    `used ${used}, allowed ${allowed} (${(used / ROWS).toFixed(1)} per row)`
  );

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  console.log("\nRound-trip budget respected.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
```

- [ ] **Step 5: Run it and confirm it FAILS**

```bash
npx tsx scripts/smoke-import-perf.ts
```

Expected: **FAIL**, reporting roughly 25–60 statements per row (the per-row `persistEmbeddingVector` and `updateContact` loops). **Record the reported per-row number in the commit message** — it is the before-figure for the entire effort, and Tasks 3 through 9 are measured against it.

- [ ] **Step 6: Commit the failing guard**

```bash
git add src/lib/query-counter.ts scripts/smoke-import-perf.ts src/db/index.ts src/lib/import-job-processor.ts
git commit -m "test: add failing round-trip budget guard for imports"
```

---

### Task 3: Write embedding vectors in one statement

**Files:**
- Modify: `src/lib/search.ts:13-20` and `:449-462`

**Interfaces:**
- Produces: `persistEmbeddingVectors(rows: Array<{ id: string; embedding: number[] }>): Promise<void>` — Task 8's backfill runner reuses it.

- [ ] **Step 1: Replace the single-row helper with a batched one**

```ts
/**
 * Copy embeddings into the pgvector column for many rows in one statement.
 *
 * This used to be one `UPDATE` per row awaited in a loop, which on `neon-http` is one
 * HTTPS request each — the largest single cost in a bulk import, and entirely invisible
 * from the outside because the result is identical either way.
 */
export async function persistEmbeddingVectors(
  rows: Array<{ id: string; embedding: number[] }>
) {
  if (!isPgvectorAvailable() || rows.length === 0) return;
  const db = await getDb();
  const tuples = rows.map(
    (row) => sql`(${row.id}::uuid, ${formatVectorLiteral(row.embedding)}::vector)`
  );
  await db.execute(sql`
    UPDATE contact_embeddings AS e
    SET embedding_vector = v.vec
    FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(id, vec)
    WHERE e.id = v.id
  `);
}
```

Keep the existing single-row `persistEmbeddingVector` as a one-line wrapper, since `upsertContactEmbedding` still calls it:

```ts
async function persistEmbeddingVector(rowId: string, embedding: number[]) {
  await persistEmbeddingVectors([{ id: rowId, embedding }]);
}
```

- [ ] **Step 2: Use it in `rebuildContactEmbeddingsBatch`**

Hoist `inserted` out of its `if` block so it is in scope afterward (`let inserted: typeof contactEmbeddings.$inferSelect[] = []`), then replace the two trailing loops (`for (const row of inserted)` and `for (const update of toUpdate)`) with:

```ts
  if (toUpdate.length > 0) {
    const tuples = toUpdate.map(
      (u) => sql`(${u.id}::uuid, ${JSON.stringify(u.embedding)}::jsonb, ${u.content}::text)`
    );
    await db.execute(sql`
      UPDATE contact_embeddings AS e
      SET embedding = v.embedding, content = v.content
      FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(id, embedding, content)
      WHERE e.id = v.id
    `);
  }

  await persistEmbeddingVectors([
    ...inserted.map((row) => ({ id: row.id, embedding: row.embedding as number[] })),
    ...toUpdate.map((u) => ({ id: u.id, embedding: u.embedding })),
  ]);
```

- [ ] **Step 3: Verify behavior is unchanged and cost dropped**

```bash
npx tsx scripts/smoke-import-engine.ts
```
Expected: all `ok`. This is a pure cost change; any behavior movement is a bug in the SQL.

```bash
npx tsx scripts/smoke-import-perf.ts
```
Expected: still FAIL, but with a substantially lower statement count than Task 2 recorded. Note the new number.

- [ ] **Step 4: Commit**

```bash
git add src/lib/search.ts
git commit -m "perf: write embedding vectors in one statement instead of one per row"
```

---

### Task 4: Merge duplicates in one statement

**Files:**
- Modify: `src/lib/contact-writes.ts` (add after `createContactsBulkForUser`)
- Modify: `src/lib/import-job-processor.ts` (replace the `for (const item of toUpdate)` loop)

**Interfaces:**
- Consumes: `CompanyResolver`, `companyFieldsForWriteCached` from `@/lib/companies`.
- Produces: `bulkMergeContactsForUser(userId: string, merges: Array<{ contactId: string; input: Partial<ContactInput> }>, companyResolve: CompanyResolver): Promise<void>`.

- [ ] **Step 1: Add the bulk merge**

Import `sql` from `drizzle-orm` in `src/lib/contact-writes.ts` if it is not already imported.

```ts
/**
 * Apply a column patch to many existing contacts in one statement.
 *
 * The import merge path used to call `updateContactForUser` per row, which re-resolved the
 * company through the *uncached* `companyFieldsForWrite` — throwing away the resolver the
 * caller had already preloaded and spending two to three round trips per merged row.
 *
 * `undefined` means "leave alone", matching `updateContactForUser`'s `!== undefined`
 * checks: each field is passed as NULL and coalesced against the existing column.
 *
 * IMPORTANT: this is the second contact-write path in the codebase. Its column list must
 * be kept in sync by hand with `updateContactForUser` above. Deliberately narrow — it
 * carries only the fields importers actually merge, and notably NOT `relationshipScore`,
 * because mirroring that into `statedCloseness` is reserved for a human moving the slider
 * (see the comment on `relationshipScore` in `updateContactForUser`).
 */
export async function bulkMergeContactsForUser(
  userId: string,
  merges: Array<{ contactId: string; input: Partial<ContactInput> }>,
  companyResolve: CompanyResolver
) {
  if (merges.length === 0) return;
  const db = await getDb();
  const now = new Date();

  const companyFields = await Promise.all(
    merges.map((m) =>
      m.input.company !== undefined
        ? companyFieldsForWriteCached(companyResolve, m.input.company)
        : Promise.resolve({ company: null, companyId: null })
    )
  );

  const tuples = merges.map((m, i) => {
    const v = m.input;
    return sql`(
      ${m.contactId}::uuid,
      ${companyFields[i].company}::text,
      ${companyFields[i].companyId}::uuid,
      ${v.title ?? null}::text,
      ${v.email ?? null}::text,
      ${v.phone ?? null}::text,
      ${v.linkedinUrl ?? null}::text,
      ${v.firstName ?? null}::text,
      ${v.lastName ?? null}::text,
      ${v.profileImageUrl ?? null}::text,
      ${v.source ?? null}::text,
      ${v.howMet ?? null}::text,
      ${normalizeMetContext(v.metContext)}::text,
      ${safeTimestamp(v.dateMet)}::timestamptz
    )`;
  });

  await db.execute(sql`
    UPDATE contacts AS c
    SET company           = COALESCE(v.company, c.company),
        company_id        = COALESCE(v.company_id, c.company_id),
        title             = COALESCE(v.title, c.title),
        email             = COALESCE(v.email, c.email),
        phone             = COALESCE(v.phone, c.phone),
        linkedin_url      = COALESCE(v.linkedin_url, c.linkedin_url),
        first_name        = COALESCE(v.first_name, c.first_name),
        last_name         = COALESCE(v.last_name, c.last_name),
        profile_image_url = COALESCE(v.profile_image_url, c.profile_image_url),
        source            = COALESCE(v.source, c.source),
        how_met           = COALESCE(v.how_met, c.how_met),
        met_context       = COALESCE(v.met_context, c.met_context),
        date_met          = COALESCE(v.date_met, c.date_met),
        updated_at        = ${now}
    FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(
      id, company, company_id, title, email, phone, linkedin_url,
      first_name, last_name, profile_image_url, source, how_met, met_context, date_met
    )
    WHERE c.id = v.id AND c.user_id = ${userId}
  `);
}
```

- [ ] **Step 2: Use it in the processor**

Replace the `for (const item of toUpdate) { await updateContact(...) }` loop in `src/lib/import-job-processor.ts` with:

```ts
      if (toUpdate.length > 0) {
        await bulkMergeContactsForUser(
          userId,
          toUpdate.map((item) => ({ contactId: item.contactId, input: item.input })),
          companyResolve
        );
        for (const item of toUpdate) {
          contactIdByRowId.set(item.row.id, item.contactId);
          touchedContactIds.push(item.contactId);
        }
        contactsUpdated += toUpdate.length;
        duplicatesFound += toUpdate.length;
      }
```

Drop the now-unused `updateContact` import. Note the merge patch no longer passes `skipCloseness` / `skipEmbedding` / `skipRevalidate` — the bulk path does none of those things by construction, which is the point. The comment explaining why closeness is deferred belongs on the recalibration call at the end of the job; move it there if it was attached to the old loop.

- [ ] **Step 3: Verify**

```bash
npx tsx scripts/smoke-import-engine.ts
```
Expected: all `ok`. The re-import case (120 merges) is what exercises this. If `updated` drifts, the COALESCE semantics differ from the old per-field `!== undefined` checks — fix the SQL, not the test.

```bash
npx tsx scripts/smoke-import-perf.ts
```
Expected: still FAIL, lower count again.

- [ ] **Step 4: Commit**

```bash
git add src/lib/contact-writes.ts src/lib/import-job-processor.ts
git commit -m "perf: merge duplicate contacts in one statement using the preloaded resolver"
```

---

### Task 5: Stop loading every contact column to build the duplicate index

**Files:**
- Modify: `src/lib/duplicates.ts`
- Modify: `src/lib/import-job-processor.ts:95-98`
- Modify: `src/actions/imports.ts` (the three `findMany` calls feeding `findDuplicateCandidates`)

**Interfaces:**
- Produces: `type DuplicateSubject = Pick<Contact, "id" | "fullName" | "email" | "linkedinUrl" | "company" | "title">`. `DuplicateMatch.contact` becomes `DuplicateSubject`; `buildDuplicateIndex`, `addToDuplicateIndex`, `findDuplicateCandidates`, and `findDuplicateCandidatesIndexed` all take and return it.

- [ ] **Step 1: Narrow the type in `src/lib/duplicates.ts`**

```ts
/**
 * The columns duplicate detection actually reads.
 *
 * Deliberately not `Contact`: the index was typed on the full row, so every caller was
 * pulling each contact's `notes`, `aiSummary`, and `keyFacts` across the wire — on every
 * import invocation, including each self-continuation — in order to compare six short
 * strings.
 */
export type DuplicateSubject = Pick<
  Contact,
  "id" | "fullName" | "email" | "linkedinUrl" | "company" | "title"
>;
```

Replace every `Contact` in this file's signatures and `Map<..., Contact[]>` types with `DuplicateSubject`. The function bodies need no changes — they already read only these six fields.

- [ ] **Step 2: Narrow the processor's query**

```ts
    existingContacts = await db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      columns: {
        id: true,
        fullName: true,
        email: true,
        linkedinUrl: true,
        company: true,
        title: true,
      },
    });
```

Change its declared type from `Contact[]` to `DuplicateSubject[]`.

- [ ] **Step 3: Fix the other call sites**

`createContactsBulk` returns full `Contact` rows, which structurally satisfy `DuplicateSubject`, so `addToDuplicateIndex(duplicateIndex, contact)` still typechecks unchanged. The Google, Outlook, and calendar paths in `src/actions/imports.ts` push full contacts into a local `existing` array — also structurally fine. Narrow those three `findMany` calls to the same six columns while you are here; they are the same waste, and Tasks 13 and 15 delete the surrounding code anyway.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
npx tsx scripts/smoke-import-engine.ts
```
Expected: `tsc` exits 0; all checks `ok`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/duplicates.ts src/lib/import-job-processor.ts src/actions/imports.ts
git commit -m "perf: load only the six columns duplicate detection reads"
```

---

### Task 6: Widen the chunk, hoist the headroom count, record the cost

**Files:**
- Modify: `src/lib/contact-writes.ts` (`ContactWriteOptions`, `createContactsBulkForUser`)
- Modify: `src/lib/import-job-processor.ts`
- Modify: `src/db/schema.ts` (`ImportStats`)

**Interfaces:**
- Consumes: `startQueryCount`, `stopQueryCount` from Task 2.
- Produces: `ContactWriteOptions.headroom?: number | null` — when supplied, `createContactsBulkForUser` skips its internal `count(*)`.

- [ ] **Step 1: Let the caller supply headroom**

Add to `ContactWriteOptions`:

```ts
  /**
   * Pre-computed remaining contact allowance, or `null` for unlimited.
   *
   * Bulk import loops know this already — they counted once at job start and track it in
   * memory. Without it every chunk pays a fresh `count(*)` over the whole contacts table
   * to re-derive a number that has not changed since the previous chunk.
   */
  headroom?: number | null;
```

In `createContactsBulkForUser`, replace `const headroom = await contactHeadroomForUser(userId);` with:

```ts
  const headroom =
    options?.headroom !== undefined
      ? options.headroom
      : await contactHeadroomForUser(userId);
```

Confirm `createContactsBulk` in `src/actions/contacts.ts` forwards `options` through unchanged — it should already.

- [ ] **Step 2: Track headroom in the processor**

Inside the existing `try`, before `while (true)`, add:

```ts
    // Counted once per invocation, not once per chunk: the number only moves because this
    // loop moves it, so re-deriving it with a full table count every chunk is a round trip
    // spent confirming arithmetic we already did.
    let headroom = await contactHeadroomForUser(userId);
```

Pass `{ skipRevalidate: true, skipEmbedding: true, headroom }` to `createContactsBulk`, and after each create:

```ts
        if (headroom !== null) headroom = Math.max(0, headroom - created.length);
```

- [ ] **Step 3: Widen the chunk and parallelize the independent tail writes**

Change `export const CHUNK_SIZE = 40;` to `export const CHUNK_SIZE = 250;` and update its comment to say the budget guard, not intuition, is what bounds it.

The three end-of-chunk writes touch disjoint row sets, so issue them together instead of serially:

```ts
      await Promise.all([
        blockedRowIds.size > 0
          ? db
              .update(importJobRows)
              .set({
                status: "skipped",
                errorMessage: PLAN_LIMIT_ROW_REASON,
                updatedAt: new Date(),
              })
              .where(inArray(importJobRows.id, [...blockedRowIds]))
          : Promise.resolve(),
        markRowsDone(doneRowIds, contactIdByRowId),
        toSkip.length > 0
          ? db
              .update(importJobRows)
              .set({ status: "skipped", updatedAt: new Date() })
              .where(inArray(importJobRows.id, toSkip.map((row) => row.id)))
          : Promise.resolve(),
      ]);
```

where `doneRowIds` is the array already built for the existing `markRowsDone` call.

- [ ] **Step 4: Re-check cancellation mid-chunk**

A 250-row chunk means a user who clicks Stop waits up to a whole chunk for it to take
effect, where before they waited for 40 rows. Re-read the job status once, after
classification and before the write phase:

```ts
      // Cancellation latency is a direct cost of the wider chunk. Classification is pure
      // and cheap, so checking here — after the rows are sorted into create/merge/skip but
      // before anything is written — costs one statement and halves the wait.
      const stillRunning = await db.query.imports.findFirst({
        where: eq(imports.id, importId),
        columns: { status: true },
      });
      if (stillRunning?.status !== "processing") return;
```

Rows claimed but not written stay `pending`, so a cancelled job leaves no partial chunk.

- [ ] **Step 5: Record what the import cost**

Add to `ImportStats` in `src/db/schema.ts`:

```ts
  /** Wall-clock milliseconds across every invocation of this job. */
  durationMs?: number;
  /** SQL statements issued across every invocation. The cost this work exists to bound. */
  statements?: number;
```

In `runLinkedInImportJob`, call `startQueryCount()` beside `const jobStart = Date.now()`, and fold both numbers into the final `imports` update:

```ts
  await db
    .update(imports)
    .set({
      status: "completed",
      stats: {
        ...(importRow.stats ?? {}),
        skipped: skippedTotal,
        blockedByPlan: blockedByPlanTotal,
        // Accumulated, not overwritten: a job that self-continues runs this several times
        // and the interesting number is the total across all of them.
        durationMs: (importRow.stats?.durationMs ?? 0) + (Date.now() - jobStart),
        statements: (importRow.stats?.statements ?? 0) + stopQueryCount(),
      },
      updatedAt: new Date(),
    })
    .where(eq(imports.id, importId));
```

- [ ] **Step 6: Verify — the budget guard should now PASS**

```bash
npx tsx scripts/smoke-import-engine.ts
npx tsx scripts/smoke-import-perf.ts
```
Expected: both all-`ok`. The perf guard passing is the payoff for Tasks 3 through 6. If it still fails, the reported per-row figure tells you roughly which loop was missed.

```bash
npx tsc --noEmit && npm run lint
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/import-job-processor.ts src/lib/contact-writes.ts src/actions/contacts.ts src/db/schema.ts
git commit -m "perf: widen import chunks, hoist the headroom count, record job cost"
```

---

## Phase 2 — Deferred embedding backfill

### Task 7: Schema for staleness, plus the unique index the backfill needs

**Files:**
- Modify: `src/db/schema.ts` (`contacts` table, `contactEmbeddings` indexes)
- Modify: `src/db/index.ts` (DDL arrays, `SCHEMA_VERSION`)
- Create: `scripts/migrate-embedding-stale.ts`
- Modify: `scripts/schema-ddl.lock.json` (regenerated by tooling, never hand-edited)

- [ ] **Step 1: Add the column and index to `schema.ts`**

On `contacts`:

```ts
  /**
   * Set when a write changed text the contact's embedding is built from.
   *
   * Imports no longer embed inline — they flag rows here and a backfill claims them. NULL
   * means "the stored embedding matches the current content", which is also true of a
   * contact that was never embedded and has no embedding row at all; the backfill treats
   * both the same way.
   */
  embeddingStaleAt: timestamp("embedding_stale_at", { withTimezone: true }),
```

On `contactEmbeddings`, add to the index list (importing `uniqueIndex` from `drizzle-orm/pg-core` if needed):

```ts
    uniqueIndex("embeddings_user_contact_source_uidx").on(
      t.userId,
      t.contactId,
      t.sourceType
    ),
```

The partial index on `contacts` cannot be expressed by Drizzle's builder, so it lives only in the raw DDL below — normal for this codebase, and `smoke-schema-ddl.ts` checks column coverage rather than index parity.

- [ ] **Step 2: Write the idempotent migration**

```ts
/**
 * Adds contacts.embedding_stale_at and the uniqueness the embedding backfill upserts on.
 *
 * Idempotent — safe to re-run. Never use `npm run db:push` for this: drizzle push drops
 * the runtime-managed embedding_vector column.
 *
 * Run: npx tsx scripts/migrate-embedding-stale.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { sql } from "drizzle-orm";
import { getDb } from "../src/db";

async function main() {
  const db = await getDb();

  await db.execute(
    sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS embedding_stale_at timestamptz`
  );
  console.log("column embedding_stale_at ready");

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS contacts_embedding_stale_idx
    ON contacts(user_id) WHERE embedding_stale_at IS NOT NULL
  `);
  console.log("partial index contacts_embedding_stale_idx ready");

  // The unique index below cannot be created while duplicates exist, and duplicates are
  // possible: nothing has ever enforced this key. Keep the newest row per key — it is the
  // one readers would have found anyway, since `findFirst` has no ORDER BY and the newest
  // row is what the last write produced.
  await db.execute(sql`
    DELETE FROM contact_embeddings a
    USING contact_embeddings b
    WHERE a.user_id = b.user_id
      AND a.contact_id = b.contact_id
      AND a.source_type = b.source_type
      AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id))
  `);
  console.log("deduped contact_embeddings");

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS embeddings_user_contact_source_uidx
    ON contact_embeddings(user_id, contact_id, source_type)
  `);
  console.log("unique index embeddings_user_contact_source_uidx ready");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  });
```

- [ ] **Step 3: Add the same four statements to the bootstrap DDL**

Add them to the Neon `alters` array and the PGlite path in `src/db/index.ts`, following the shape of the neighbouring `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS` entries. Then bump `SCHEMA_VERSION` from `6` to `7`.

- [ ] **Step 4: Run the DDL guard, confirm it fails, then regenerate the lock**

```bash
npx tsx scripts/smoke-schema-ddl.ts
```
Expected: FAIL, reporting the fingerprint changed. That is the guard working. Confirm it also reports **coverage** passing — if it flags `embedding_stale_at` as uncovered, Step 3 missed one of the arrays, and that is the failure mode this guard exists to catch.

```bash
npx tsx scripts/smoke-schema-ddl.ts --update
npx tsx scripts/smoke-schema-ddl.ts
```
Expected: the second run passes.

- [ ] **Step 5: Apply locally and confirm nothing broke**

```bash
npx tsx scripts/migrate-embedding-stale.ts
npx tsx scripts/smoke-import-engine.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/index.ts scripts/migrate-embedding-stale.ts scripts/schema-ddl.lock.json
git commit -m "feat: add embedding_stale_at and the embedding uniqueness key"
```

---

### Task 8: The backfill runner

**Files:**
- Create: `scripts/smoke-embedding-backfill.ts`
- Create: `src/lib/embedding-backfill.ts`
- Modify: `src/lib/search.ts` (export `buildContactEmbeddingContent`)

**Interfaces:**
- Consumes: `persistEmbeddingVectors` (Task 3), `createEmbeddingsBatch` from `@/lib/ai`.
- Produces: `runEmbeddingBackfill(userId: string): Promise<{ embedded: number; remaining: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The backfill is what makes deferring embeddings safe: if it does not drain, imported
 * contacts are silently missing from search forever.
 *
 * Run: npx tsx scripts/smoke-embedding-backfill.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { and, count, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactEmbeddings, contacts, userSettings } from "../src/db/schema";
import { runEmbeddingBackfill } from "../src/lib/embedding-backfill";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-embedding-backfill-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function staleCount() {
  const db = await getDb();
  const [row] = await db
    .select({ value: count() })
    .from(contacts)
    .where(and(eq(contacts.userId, USER), isNotNull(contacts.embeddingStaleAt)));
  return row?.value ?? 0;
}

async function main() {
  console.log("Embedding backfill (pglite)...");
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  const now = new Date();
  await db.insert(contacts).values(
    Array.from({ length: 30 }, (_, i) => ({
      userId: USER,
      fullName: `Stale Person ${i}`,
      company: `Company ${i % 5}`,
      title: `Title ${i % 3}`,
      embeddingStaleAt: now,
    }))
  );

  check("fixture starts stale", (await staleCount()) === 30);

  const first = await runEmbeddingBackfill(USER);
  const remaining = await staleCount();

  // With no AI key configured, `createEmbeddingsBatch` throws and the runner must leave
  // the flags set so the next pass retries. With a key present it drains. Both are
  // correct; clearing flags for work that did not happen is not.
  check(
    "backfill either drains or leaves the work claimable",
    remaining === 0 ? first.embedded === 30 : remaining === 30,
    `embedded ${first.embedded}, remaining ${remaining}`
  );

  if (remaining === 0) {
    const [row] = await db
      .select({ value: count() })
      .from(contactEmbeddings)
      .where(eq(contactEmbeddings.userId, USER));
    check("one embedding row per contact", (row?.value ?? 0) === 30, `rows ${row?.value}`);

    // Idempotence: nothing is stale, so a second pass must be a no-op, not a re-embed.
    const second = await runEmbeddingBackfill(USER);
    check("second pass is a no-op", second.embedded === 0, JSON.stringify(second));
  }

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  console.log("\nBackfill checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx tsx scripts/smoke-embedding-backfill.ts
```
Expected: FAIL with `Cannot find module '../src/lib/embedding-backfill'`.

- [ ] **Step 3: Write the runner**

```ts
/**
 * Fills in embeddings for contacts flagged `embedding_stale_at`.
 *
 * Imports no longer embed inline: an embedding call is a network round trip to an AI
 * provider sitting in the middle of a write loop, which made a large import both slow and
 * hostage to that provider's availability. Imports flag rows instead, and this drains them
 * afterwards.
 *
 * Time-boxed and self-continuing, the same shape as the import engine — a user with
 * thousands of stale contacts must not need a single invocation to hold them all.
 */
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { createEmbeddingsBatch } from "@/lib/ai";
import { buildContactEmbeddingContent, persistEmbeddingVectors } from "@/lib/search";

/** Contacts claimed per pass. */
const CLAIM_SIZE = 500;
/** Texts per provider call — well under OpenAI's input cap, small enough to retry cheaply. */
const EMBED_BATCH = 200;
/** Leaves room under the 300s ceiling for a self-continuation request. */
const TIME_BUDGET_MS = 4.5 * 60 * 1000;

export async function runEmbeddingBackfill(
  userId: string
): Promise<{ embedded: number; remaining: number }> {
  const db = await getDb();
  const start = Date.now();
  let embedded = 0;

  while (Date.now() - start < TIME_BUDGET_MS) {
    const stale = await db.query.contacts.findMany({
      where: and(eq(contacts.userId, userId), isNotNull(contacts.embeddingStaleAt)),
      orderBy: [asc(contacts.embeddingStaleAt)],
      limit: CLAIM_SIZE,
      with: { contactTags: { with: { tag: true } } },
    });
    if (stale.length === 0) break;

    const entries = stale
      .map((contact) => ({
        contactId: contact.id,
        content: buildContactEmbeddingContent(contact),
      }))
      .filter((entry) => entry.content.trim().length > 0);

    const embeddable = new Set(entries.map((entry) => entry.contactId));
    // A contact with no embeddable text is not pending work — clear its flag so the loop
    // cannot spin on it forever, but write no embedding row.
    const emptyIds = stale.map((c) => c.id).filter((id) => !embeddable.has(id));

    for (let i = 0; i < entries.length; i += EMBED_BATCH) {
      const slice = entries.slice(i, i + EMBED_BATCH);
      // Deliberately not caught: a provider failure must leave `embedding_stale_at` set so
      // the next pass retries. Swallowing it here would silently drop the work.
      const vectors = await createEmbeddingsBatch(
        userId,
        slice.map((entry) => entry.content)
      );

      const tuples = slice.map(
        (entry, j) => sql`(
          ${userId}::text, ${entry.contactId}::uuid, 'profile'::text,
          ${entry.contactId}::text, ${JSON.stringify(vectors[j])}::jsonb,
          ${entry.content}::text
        )`
      );

      const result = await db.execute(sql`
        INSERT INTO contact_embeddings
          (user_id, contact_id, source_type, source_id, embedding, content)
        VALUES ${sql.join(tuples, sql`, `)}
        ON CONFLICT (user_id, contact_id, source_type)
        DO UPDATE SET embedding = EXCLUDED.embedding, content = EXCLUDED.content
        RETURNING id, contact_id
      `);

      // `db.execute` returns an array on neon-http and `{ rows }` on PGlite; both drivers
      // are in play (production and local), so neither shape can be assumed.
      const returned = (Array.isArray(result)
        ? result
        : (result as { rows?: unknown[] }).rows ?? []) as Array<{
        id: string;
        contact_id: string;
      }>;
      const idByContact = new Map(returned.map((r) => [r.contact_id, r.id]));

      await persistEmbeddingVectors(
        slice
          .map((entry, j) => ({
            id: idByContact.get(entry.contactId) ?? "",
            embedding: vectors[j],
          }))
          .filter((row) => row.id)
      );

      await db
        .update(contacts)
        .set({ embeddingStaleAt: null })
        .where(inArray(contacts.id, slice.map((entry) => entry.contactId)));

      embedded += slice.length;
    }

    if (emptyIds.length > 0) {
      await db
        .update(contacts)
        .set({ embeddingStaleAt: null })
        .where(inArray(contacts.id, emptyIds));
    }
  }

  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), isNotNull(contacts.embeddingStaleAt)));

  return { embedded, remaining: Number(row?.value ?? 0) };
}
```

Export `buildContactEmbeddingContent` from `src/lib/search.ts` (it is currently module-private).

- [ ] **Step 4: Run to verify it passes**

```bash
npx tsx scripts/smoke-embedding-backfill.ts
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/embedding-backfill.ts scripts/smoke-embedding-backfill.ts src/lib/search.ts
git commit -m "feat: add batched embedding backfill runner"
```

---

### Task 9: Take embeddings off the import's critical path

**Files:**
- Modify: `src/lib/contact-writes.ts` (`createContactsBulkForUser`, `bulkMergeContactsForUser`)
- Modify: `src/lib/import-job-processor.ts`
- Create: `src/app/api/embeddings/backfill/route.ts`
- Modify: `src/app/api/imports/process-stalled/route.ts`

**Interfaces:**
- Consumes: `runEmbeddingBackfill` (Task 8).
- Produces: `POST /api/embeddings/backfill` taking `{ userId: string }`, `CRON_SECRET`-authorized.

Read `node_modules/next/dist/docs/` on route handlers before writing the route — this Next.js version differs from what you may remember.

- [ ] **Step 1: Flag instead of embedding, in both bulk write paths**

In `createContactsBulkForUser`:

```ts
  const values = admitted.map((input, i) => ({
    ...contactInsertValues(userId, input, companyFieldsList[i], now),
    // Flagged, not embedded. `skipEmbedding` used to mean "the caller will embed these in
    // a batch"; it now means "the backfill will" — the same promise with the provider call
    // moved out of the write loop.
    ...(options?.skipEmbedding ? { embeddingStaleAt: now } : {}),
  }));
```

In `bulkMergeContactsForUser`, add to the `SET` clause:

```sql
        embedding_stale_at = ${now},
```

A merge changes company and title, both of which `buildContactEmbeddingContent` reads, so the stored embedding is genuinely stale afterward.

- [ ] **Step 2: Remove the inline embedding call from the processor**

Delete the `if (touchedContactIds.length > 0) { await rebuildContactEmbeddingsBatch(...) }` block and its import. Keep `allTouchedContactIds` — the revalidation guard still uses it.

Add beside `scheduleContinuation`:

```ts
/**
 * Fire-and-forget the embedding backfill for this user.
 *
 * Through the route rather than inline: the import is finished from the user's point of
 * view, and embedding a few thousand contacts can outlive this invocation. The daily cron
 * is a backstop only — it runs at most once every 24 hours (the Hobby-plan minimum),
 * which is far too slow to be the primary path.
 */
async function kickEmbeddingBackfill(userId: string) {
  const secret = process.env.CRON_SECRET;
  try {
    await fetch(`${getAppBaseUrl()}/api/embeddings/backfill`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({ userId }),
    });
  } catch {
    // Best-effort — the cron backstop picks up anything still flagged.
  }
}
```

and call `await kickEmbeddingBackfill(importRow.userId);` after `recalibrateCloseness`.

- [ ] **Step 3: Write the route**

```ts
import { NextResponse } from "next/server";
import { after } from "next/server";
import { runEmbeddingBackfill } from "@/lib/embedding-backfill";

export const maxDuration = 300;

/** Internal kick target — not user-facing. Authorized via the shared cron secret. */
function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return new NextResponse(null, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { userId?: string } | null;
  const userId = body?.userId;
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  after(() => runEmbeddingBackfill(userId).catch(() => {}));

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Add the cron backstop**

In `src/app/api/imports/process-stalled/route.ts`, add `embeddingsGenerated: 0` to `stats` and `const EMBED_BACKFILL_USERS = 10;` beside the other bounds. Then add a block alongside the existing housekeeping `try`s (so a failure downgrades the run to `partial` rather than failing it):

```ts
    try {
      // Backstop only — imports kick the backfill directly on completion. This catches
      // users whose kick was lost along with the invocation that sent it.
      const staleUsers = await db
        .selectDistinct({ userId: contacts.userId })
        .from(contacts)
        .where(isNotNull(contacts.embeddingStaleAt))
        .limit(EMBED_BACKFILL_USERS);
      for (const { userId: staleUser } of staleUsers) {
        const res = await runEmbeddingBackfill(staleUser).catch(() => null);
        stats.embeddingsGenerated += res?.embedded ?? 0;
      }
    } catch {
      status = "partial";
    }
```

Add `contacts` and `isNotNull` to the imports.

- [ ] **Step 5: Verify**

```bash
npx tsx scripts/smoke-import-engine.ts
npx tsx scripts/smoke-import-perf.ts
npx tsx scripts/smoke-embedding-backfill.ts
npx tsc --noEmit && npm run lint
```
Expected: all pass. The perf guard's number should drop again — the embedding statements have left the chunk loop entirely.

- [ ] **Step 6: Commit**

```bash
git add src/lib/import-job-processor.ts src/lib/contact-writes.ts src/app/api/embeddings/backfill/route.ts src/app/api/imports/process-stalled/route.ts
git commit -m "perf: flag contacts for embedding instead of embedding inline during import"
```

---

## Phase 3 — The engine

### Task 10: Extract the engine and prove it on LinkedIn

Behavior must not move. `scripts/smoke-import-engine.ts` from Task 1 is the gate.

**Files:**
- Create: `src/lib/import-engine.ts`
- Create: `src/lib/import-adapters/index.ts`, `src/lib/import-adapters/linkedin-connections.ts`
- Modify: `src/lib/import-job-processor.ts` (becomes a thin re-export)
- Modify: `src/lib/import-job-dispatch.ts`

**Interfaces:**
- Produces:
  - `type DuplicateProbe = { fullName?: string | null; email?: string | null; linkedinUrl?: string | null; company?: string | null; title?: string | null }`
  - `type InteractionInsert = typeof interactions.$inferInsert`
  - `type ImportAdapter<P>` with `identity`, `toCreate`, `toMerge`, optional `createsContacts` (default `true`), optional `interactions`
  - `runImportJob(importId: string): Promise<void>` in `import-engine.ts`
  - `getAdapter(importType: string): ImportAdapter<ImportJobRowPayload> | null` in `import-adapters/index.ts`

- [ ] **Step 1: Define the adapter type**

In `src/lib/import-engine.ts`:

```ts
/** The incoming shape `findDuplicateCandidatesIndexed` already accepts. */
export type DuplicateProbe = {
  fullName?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  company?: string | null;
  title?: string | null;
};

export type InteractionInsert = typeof interactions.$inferInsert;

/**
 * Everything an import type has to say about its own rows.
 *
 * Deliberately all pure functions: the engine owns every database statement, which is the
 * only way the per-chunk round-trip budget can be a property of the system rather than a
 * habit each importer has to remember.
 */
export type ImportAdapter<P> = {
  /** Fields the duplicate index probes. `null` marks the row skipped. */
  identity(payload: P): DuplicateProbe | null;
  /** The contact to insert when nothing matches confidently. */
  toCreate(payload: P): ContactInput;
  /** The column patch to apply when a confident duplicate matches. */
  toMerge(payload: P, matched: DuplicateSubject): Partial<ContactInput>;
  /**
   * Set false for imports that only annotate people already in the network (calendar).
   * The engine then skips the create branch and the plan cap entirely — a calendar file
   * cannot push a free user over their contact limit, because it adds no contacts.
   */
  createsContacts?: boolean;
  /** Interaction rows to bulk-insert for this payload, once its contact id is known. */
  interactions?(payload: P, contactId: string, userId: string): InteractionInsert[];
};
```

- [ ] **Step 2: Move the loop into the engine**

Copy `runLinkedInImportJob`'s body into `runImportJob(importId)` verbatim, then make four substitutions:

1. Row classification calls `adapter.identity` / `adapter.toCreate` / `adapter.toMerge` instead of the inline LinkedIn field mapping.
2. The adapter is resolved once via `getAdapter(importRow.importType)`; return early if it is `null`.
3. When `adapter.createsContacts === false`, skip the `toCreate` branch, the headroom count, and all plan-blocked handling.
4. After creates and merges, if `adapter.interactions` exists, collect rows across the whole chunk and issue **one** `db.insert(interactions).values(rows)`.

Keep every existing comment explaining *why*: the plan-cap slicing, the deferred closeness, the single recalibration, the revalidate limit. They are the reasons the loop looks the way it does, and they are the first thing a reader will need.

- [ ] **Step 3: Write the LinkedIn adapter**

`src/lib/import-adapters/linkedin-connections.ts` — the bodies lift out of the processor unchanged:

```ts
export const linkedinConnectionsAdapter: ImportAdapter<LinkedInImportRowPayload> = {
  identity(payload) {
    const fullName = `${payload.firstName} ${payload.lastName}`.trim();
    if (!fullName) return null;
    return {
      fullName,
      email: payload.email,
      linkedinUrl: payload.url,
      company: payload.company,
      title: payload.position,
    };
  },

  toCreate(payload) {
    const connectedOn = parseConnectedOn(payload.connectedOn || "");
    return {
      fullName: `${payload.firstName} ${payload.lastName}`.trim(),
      firstName: payload.firstName,
      lastName: payload.lastName,
      company: payload.company || undefined,
      title: payload.position || undefined,
      email: payload.email || undefined,
      linkedinUrl: payload.url || undefined,
      source: "linkedin",
      // No statedCloseness: nobody has rated these people, and saying "2 out of 5" about
      // two thousand strangers is exactly the assumption this omission removes.
      firstInteractionAt: connectedOn ?? undefined,
      dateMet: connectedOn,
      howMet: "LinkedIn connection",
      metContext: "online",
      tagNames: ["linkedin"],
    };
  },

  toMerge(payload) {
    const connectedOn = parseConnectedOn(payload.connectedOn || "");
    return {
      company: payload.company || undefined,
      title: payload.position || undefined,
      email: payload.email || undefined,
      linkedinUrl: payload.url || undefined,
      firstName: payload.firstName || undefined,
      lastName: payload.lastName || undefined,
      source: "linkedin",
      dateMet: connectedOn || undefined,
      howMet: "LinkedIn connection",
      metContext: "online",
    };
  },
};
```

`src/lib/import-adapters/index.ts` maps `LINKEDIN_IMPORT_TYPE` to it and returns `null` for anything else.

- [ ] **Step 4: Reduce the processor and route dispatch**

In `src/lib/import-job-processor.ts`, replace the function with `export const runLinkedInImportJob = runImportJob;` — keeping the name means the cron, the continue route, and `startLinkedInImport`'s `after()` need no edits. `CHUNK_SIZE` moves to `import-engine.ts`; re-export it from the processor (`export { CHUNK_SIZE } from "@/lib/import-engine";`) so `scripts/smoke-import-perf.ts` keeps resolving it. In `import-job-dispatch.ts`, route `LINKEDIN_IMPORT_TYPE` to `runImportJob`.

- [ ] **Step 5: Verify nothing moved**

```bash
npx tsx scripts/smoke-import-engine.ts
npx tsx scripts/smoke-import-perf.ts
npx tsc --noEmit && npm run lint
```
Expected: all pass, with the same numbers as before. This task adds no capability — the only evidence of success is that nothing changed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/import-engine.ts src/lib/import-adapters src/lib/import-job-processor.ts src/lib/import-job-dispatch.ts
git commit -m "refactor: extract the import engine, with LinkedIn as its first adapter"
```

---

### Task 11: Claim rows before writing them

**Files:**
- Modify: `scripts/smoke-import-engine.ts` (one new case)
- Modify: `src/lib/import-engine.ts`

- [ ] **Step 1: Write the failing test**

Append to `main()` in `scripts/smoke-import-engine.ts`, before the final reset. Add `count` to the `drizzle-orm` imports and `importJobRows` to the schema imports.

```ts
  // --- a chunk interrupted mid-write must not duplicate on resume ---
  await reset();
  id = await seedJob(fixture(20));
  const db3 = await getDb();
  await runLinkedInImportJob(id);
  // Simulate a crash after contacts were inserted but before rows were marked done: the
  // rows sit in `processing`, which is exactly the state the claim step leaves behind.
  await db3
    .update(importJobRows)
    .set({ status: "processing" })
    .where(eq(importJobRows.importId, id));
  await db3.update(imports).set({ status: "processing" }).where(eq(imports.id, id));
  await runLinkedInImportJob(id);
  const [resumed] = await db3
    .select({ value: count() })
    .from(contacts)
    .where(eq(contacts.userId, USER));
  check(
    "resuming a half-written chunk merges rather than duplicates",
    (resumed?.value ?? 0) === 20,
    `contacts: ${resumed?.value}`
  );
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx tsx scripts/smoke-import-engine.ts
```
Expected: FAIL. Before the claim exists, the engine only reads `status = 'pending'`, so the `processing` rows are never re-run — record which way it fails (stuck rows, or a duplicated count) so you can tell the fix worked for the right reason.

- [ ] **Step 3: Claim before writing**

Replace the pending-rows `findMany` in `import-engine.ts`:

```ts
      /**
       * Claim the next chunk in the same statement that reads it.
       *
       * `neon-http` has no transactions, so a crash between "insert contacts" and "mark
       * rows done" would otherwise leave rows `pending` and re-create their contacts on
       * resume. Claiming first means an interrupted chunk is left `processing`, and a
       * resumed job re-runs those rows through the duplicate index — which now matches the
       * contact that was created and merges instead of duplicating. Self-healing for any
       * row carrying a LinkedIn URL or an email; a name-only row can still duplicate,
       * which is strictly better than the alternative and worth knowing about.
       *
       * It also costs nothing: one UPDATE replaces one SELECT.
       */
      const claimed = await db.execute(sql`
        UPDATE import_job_rows SET status = 'processing', updated_at = ${new Date()}
        WHERE id IN (
          SELECT id FROM import_job_rows
          WHERE import_id = ${importId} AND status IN ('pending', 'processing')
          ORDER BY row_index
          LIMIT ${CHUNK_SIZE}
        )
        RETURNING id, row_index, payload, status, contact_id
      `);
```

Normalize the driver-dependent result shape (`Array.isArray(claimed) ? claimed : claimed.rows`) and map the snake_case columns onto the camelCase fields the loop reads. The exit condition stays `if (pendingRows.length === 0) break;`.

- [ ] **Step 4: Run to verify it passes**

```bash
npx tsx scripts/smoke-import-engine.ts
npx tsx scripts/smoke-import-perf.ts
```
Expected: both pass. The perf guard must not regress — this trades one statement for another.

- [ ] **Step 5: Commit**

```bash
git add src/lib/import-engine.ts scripts/smoke-import-engine.ts
git commit -m "fix: claim import rows before writing so interrupted chunks resume safely"
```

---

### Task 12: Narrow a failing chunk instead of failing the import

**Files:**
- Modify: `scripts/smoke-import-engine.ts`
- Modify: `src/lib/import-engine.ts`

- [ ] **Step 1: Write the failing test**

```ts
  // --- one poisonous row must not take the whole import with it ---
  await reset();
  const poisoned = fixture(30);
  // A value the database will refuse. The other 29 rows are fine.
  poisoned[7].email = "bad value@example.com";
  id = await seedJob(poisoned);
  await runLinkedInImportJob(id);
  out = await outcome(id);
  check("import survives a bad row", out.status === "completed", JSON.stringify(out));
  check("good rows still land", out.created >= 29, JSON.stringify(out));
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx tsx scripts/smoke-import-engine.ts
```
Expected: FAIL with `status === "failed"` — the chunk's insert threw and `failImport` caught it at the top level. If the NUL byte does not actually error under PGlite, substitute something that does (an oversized `first_name`, for instance); the point is a row the database refuses, not a specific value.

- [ ] **Step 3: Add chunk narrowing**

```ts
/**
 * Run a chunk's writes, splitting on failure until the bad rows are isolated.
 *
 * With 250-row statements, all-or-nothing failure means one malformed row costs an entire
 * import — the larger the chunk, the worse that trade gets. Halving costs at most
 * log2(chunk) extra attempts, and only when something is actually wrong, so the happy path
 * is untouched.
 */
async function writeWithNarrowing<T>(
  items: T[],
  write: (batch: T[]) => Promise<void>,
  onBadRow: (item: T, err: unknown) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  try {
    await write(items);
  } catch (err) {
    if (items.length === 1) {
      await onBadRow(items[0], err);
      return;
    }
    const mid = Math.ceil(items.length / 2);
    await writeWithNarrowing(items.slice(0, mid), write, onBadRow);
    await writeWithNarrowing(items.slice(mid), write, onBadRow);
  }
}
```

`onBadRow` marks that row terminally failed, so the loop cannot spin on it:

```ts
        await db
          .update(importJobRows)
          .set({
            status: "failed",
            errorMessage: (err instanceof Error ? err.message : "Row failed").slice(0, 500),
            updatedAt: new Date(),
          })
          .where(eq(importJobRows.id, row.id));
```

Apply `writeWithNarrowing` to the create batch and to the merge batch.

- [ ] **Step 4: Run to verify it passes**

```bash
npx tsx scripts/smoke-import-engine.ts
npx tsx scripts/smoke-import-perf.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/import-engine.ts scripts/smoke-import-engine.ts
git commit -m "fix: isolate bad import rows by narrowing the chunk instead of failing the job"
```

---

### Task 13: Move Google and Outlook contacts onto the engine

The biggest user-visible win: these currently spend roughly 15 round trips and one AI call per contact, synchronously, with no resume.

**Files:**
- Modify: `scripts/smoke-import-engine.ts`
- Modify: `src/db/schema.ts` (payload union)
- Create: `src/lib/import-adapters/google-contacts.ts`, `src/lib/import-adapters/outlook-contacts.ts`
- Modify: `src/lib/import-adapters/index.ts`, `src/lib/import-job-dispatch.ts`
- Modify: `src/actions/imports.ts:1161-1252` and `:1324-1414`
- Modify: `src/components/imports/google-contacts-import.tsx`, `outlook-contacts-import.tsx`

**Interfaces:**
- Produces: payload kinds `google_contact` and `outlook_contact` on `ImportJobRowPayload`; `GOOGLE_CONTACTS_IMPORT_TYPE = "google_contacts"` and `OUTLOOK_CONTACTS_IMPORT_TYPE = "outlook_contacts"` on `import-job-dispatch.ts`, both added to `RESUMABLE_IMPORT_TYPES`; both confirm actions now return `{ importId: string; totalRows: number }` instead of `{ created, updated, blockedByPlan }`.

- [ ] **Step 1: Write the failing test**

First widen `seedJob` to take the import type and any payload shape:

```ts
async function seedJob(rows: object[], importType = "linkedin_connections") {
  const db = await getDb();
  const [job] = await db
    .insert(imports)
    .values({
      userId: USER,
      importType,
      fileName: "fixture.csv",
      status: "processing",
      totalRows: rows.length,
      stats: {},
    })
    .returning();
  await db.insert(importJobRows).values(
    rows.map((payload, i) => ({ importId: job.id, userId: USER, rowIndex: i, payload }))
  );
  return job.id;
}
```

Then add the case. Note it runs through `runImportJobById`, not `runLinkedInImportJob`, and
that duplicates key on **email** here rather than a LinkedIn URL:

```ts
  // --- Google contacts run the same engine, keyed on email ---
  await reset();
  const google = Array.from({ length: 40 }, (_, i) => ({
    kind: "google_contact" as const,
    resourceName: `people/c${i}`,
    fullName: `Google Person ${i}`,
    firstName: "Google",
    lastName: `Person ${i}`,
    company: `Company ${i % 6}`,
    title: `Title ${i % 4}`,
    email: `google${i}@example.com`,
    phone: "",
    photoUrl: "",
  }));
  google[5].fullName = "   ";

  id = await seedJob(google, "google_contacts");
  await runImportJobById(id);
  out = await outcome(id);
  check("google import completes", out.status === "completed", JSON.stringify(out));
  check("google creates all but the nameless row", out.created === 39, JSON.stringify(out));
  check("google skips the nameless row", out.skipped === 1, JSON.stringify(out));

  // Re-running the same export must merge on email, not duplicate.
  id = await seedJob(google, "google_contacts");
  await runImportJobById(id);
  out = await outcome(id);
  check("google re-import merges", out.updated === 39, JSON.stringify(out));
  check("google re-import creates none", out.created === 0, JSON.stringify(out));
```

Add `runImportJobById` to the imports at the top of the file.

- [ ] **Step 2: Run to verify it fails**

```bash
npx tsx scripts/smoke-import-engine.ts
```
Expected: FAIL — no adapter is registered for `google_contacts`, so `runImportJobById` returns without processing and every count stays 0.

- [ ] **Step 3: Add payload kinds and adapters**

```ts
export type GoogleContactRowPayload = {
  kind: "google_contact";
  resourceName: string;
  fullName: string;
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  photoUrl: string;
};

export type OutlookContactRowPayload = {
  kind: "outlook_contact";
  id: string;
  fullName: string;
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  email: string;
  phone: string;
};
```

Add both to the `ImportJobRowPayload` union. The adapters lift the field mappings out of the loops being deleted, verbatim: `identity` returns `null` when `fullName.trim()` is empty; `toCreate` carries `source`, `howMet`, `metContext`, `relationshipScore: 2`, and `tagNames: ["google-contacts"]` / `["outlook-contacts"]`; `toMerge` carries exactly the patch the old `updateContact` call passed.

Keep `relationshipScore: 2` explicit even though `contactInsertValues` coalesces to the same value — this task should change plumbing only.

- [ ] **Step 4: Rewrite the ingests**

The whole action collapses to a snapshot plus a handoff:

```ts
export async function confirmGoogleContactsImport(
  selectedIds: string[]
): Promise<{ importId: string; totalRows: number }> {
  const userId = await requireUserId();
  const db = await getDb();

  const accessToken = await getValidAccessToken(userId);
  const googleContacts = await fetchGooglePeopleContacts(accessToken);
  const selected = new Set(selectedIds);
  const rows = googleContacts.filter((p) => selected.has(p.resourceName));
  if (rows.length === 0) throw new Error("No contacts selected to import");

  const [importRow] = await db
    .insert(imports)
    .values({
      userId,
      importType: GOOGLE_CONTACTS_IMPORT_TYPE,
      fileName: "Google Contacts",
      status: "processing",
      totalRows: rows.length,
      stats: {},
    })
    .returning();

  // Snapshot the API response into job rows rather than holding it in this invocation:
  // this action used to do the entire import inline, one contact at a time, which is why a
  // large mailbox hit the function ceiling and left nothing recoverable behind.
  await db.insert(importJobRows).values(
    rows.map((row, index) => ({
      importId: importRow.id,
      userId,
      rowIndex: index,
      payload: {
        kind: "google_contact" as const,
        resourceName: row.resourceName,
        fullName: row.fullName,
        firstName: row.firstName,
        lastName: row.lastName,
        company: row.company,
        title: row.title,
        email: row.email,
        phone: row.phone,
        photoUrl: row.photoUrl,
      },
    }))
  );

  after(() => runImportJobById(importRow.id).catch(() => {}));
  revalidatePath("/imports");

  return { importId: importRow.id, totalRows: rows.length };
}
```

Delete the per-row loop, the `existing` contacts load, and the trailing `refreshOutreachSuggestions` — the engine's completion path owns finalization now. `confirmOutlookContactsImport` is the identical shape with `OUTLOOK_CONTACTS_IMPORT_TYPE`, `fetchOutlookContacts`, `row.id` in place of `resourceName`, and no `photoUrl`.

- [ ] **Step 5: Point the UI at the poll-based watcher**

Both components currently await the confirm action and render its counts. Switch them to the start-then-poll flow `linkedin-connections-import.tsx` already uses. Read that component and mirror it rather than inventing a second progress convention.

- [ ] **Step 6: Verify**

```bash
npx tsx scripts/smoke-import-engine.ts
npx tsx scripts/smoke-import-perf.ts
npx tsc --noEmit && npm run lint
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/import-adapters src/db/schema.ts src/actions/imports.ts src/components/imports src/lib/import-job-dispatch.ts scripts/smoke-import-engine.ts
git commit -m "perf: move Google and Outlook contact imports onto the resumable engine"
```

---

### Task 14: Move the LinkedIn messages import server-side

This is what kills the re-upload-the-whole-CSV-every-8-conversations behavior.

**Files:**
- Modify: `scripts/smoke-import-engine.ts`
- Modify: `src/db/schema.ts`
- Create: `src/lib/import-adapters/linkedin-messages.ts`
- Modify: `src/lib/import-adapters/index.ts`, `src/lib/import-job-dispatch.ts`
- Modify: `src/actions/imports.ts:374` (`confirmLinkedInMessagesImport` becomes `startLinkedInMessagesImport`)
- Modify: `src/lib/import-job-runner.ts` (delete the `runBatches` path for messages)

**Interfaces:**
- Produces: payload kind `linkedin_message_thread` carrying one conversation's participant identity plus its messages; `startLinkedInMessagesImport(csvText: string, fileName: string, selectedConversationIds?: string[]): Promise<{ importId: string; totalRows: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
  // --- LinkedIn messages: creates contacts AND logs interactions ---
  await reset();
  const threads = Array.from({ length: 12 }, (_, i) => ({
    kind: "linkedin_message_thread" as const,
    conversationId: `conv-${i}`,
    fullName: `Msg Person ${i}`,
    firstName: "Msg",
    lastName: `Person ${i}`,
    // The row with no profile URL is the one today's importer skips; keep that.
    linkedinUrl: i === 4 ? "" : `https://www.linkedin.com/in/msg-person-${i}`,
    messages: [
      { id: `m-${i}-a`, body: "first message", sentAt: "2024-03-01T10:00:00Z" },
      { id: `m-${i}-b`, body: "second message", sentAt: "2024-03-02T10:00:00Z" },
    ],
  }));

  id = await seedJob(threads, "linkedin_messages");
  await runImportJobById(id);
  out = await outcome(id);
  check("messages import completes", out.status === "completed", JSON.stringify(out));
  check("thread without a profile url is skipped", out.skipped === 1, JSON.stringify(out));
  check("remaining threads create contacts", out.created === 11, JSON.stringify(out));

  const db4 = await getDb();
  const [logged] = await db4
    .select({ value: count() })
    .from(interactions)
    .where(eq(interactions.userId, USER));
  check("two messages logged per thread", (logged?.value ?? 0) === 22, `rows ${logged?.value}`);

  // Re-importing the same export must merge the people and log nothing twice.
  id = await seedJob(threads, "linkedin_messages");
  await runImportJobById(id);
  out = await outcome(id);
  check("messages re-import merges", out.updated === 11, JSON.stringify(out));
  const [loggedAgain] = await db4
    .select({ value: count() })
    .from(interactions)
    .where(eq(interactions.userId, USER));
  check(
    "re-import logs no duplicate messages",
    (loggedAgain?.value ?? 0) === 22,
    `rows ${loggedAgain?.value}`
  );
```

Add `interactions` to the schema imports, and delete the user's `interactions` rows in `reset()`.

- [ ] **Step 2: Run to verify it fails**

```bash
npx tsx scripts/smoke-import-engine.ts
```
Expected: FAIL — no `linkedin_message_thread` adapter is registered.

- [ ] **Step 3: Write the adapter with its `interactions` hook**

`identity` returns `null` when the conversation has no `linkedinUrl`. `toCreate` carries `tagNames: ["linkedin", "messages"]` and `source: "linkedin_messages"`. `interactions(payload, contactId, userId)` returns one row per message with `interactionType`, `source: "linkedin_messages"`, `sourceId` set to the message id, and `interactionDate`.

Today, already-imported messages are filtered by querying `interactions` **per conversation**. Move that into the engine's interactions step: one query for existing `source_id` values across the whole chunk, then filter in memory. Same per-chunk-not-per-row rule as everywhere else — a straight port of the old query would reintroduce exactly the cost this work removes.

- [ ] **Step 4: Rewrite ingest and delete the client batching**

`startLinkedInMessagesImport` parses the CSV **once**, server-side, writes one job row per selected conversation, and kicks the job. In `src/lib/import-job-runner.ts`, the `"messages"` branch becomes the same start-then-poll flow as `"connections"`. `runBatches`, `IMPORT_BATCH_SIZE`, and the messages-only `beforeunload` warning all become dead code — delete them. The import now survives navigation the way connections does, which is what that warning existed to apologize for.

- [ ] **Step 5: Verify**

```bash
npx tsx scripts/smoke-import-engine.ts
npx tsx scripts/smoke-import-perf.ts
npx tsc --noEmit && npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/import-adapters src/db/schema.ts src/actions/imports.ts src/lib/import-job-runner.ts src/lib/import-job-dispatch.ts scripts/smoke-import-engine.ts
git commit -m "perf: parse the LinkedIn messages CSV once, server-side, on the engine"
```

---

### Task 15: Move the calendar import onto the engine

The structurally different one: it never creates contacts.

**Files:**
- Modify: `scripts/smoke-import-engine.ts`
- Modify: `src/db/schema.ts`
- Create: `src/lib/import-adapters/calendar.ts`
- Modify: `src/lib/import-adapters/index.ts`, `src/lib/import-job-dispatch.ts`
- Modify: `src/actions/imports.ts:797` (`confirmCalendarImport`)
- Modify: `src/components/imports/calendar-import-section.tsx`

**Interfaces:**
- Produces: payload kind `calendar_event` carrying one windowed event (uid, summary, description, location, start, end, attendees, organizer); the calendar adapter sets `createsContacts: false`.

- [ ] **Step 1: Write the failing test**

```ts
  // --- Calendar: annotates people already in the network, never adds any ---
  await reset();
  // Seed the network first — calendar matching has nothing to match against otherwise.
  const known = await seedJob(fixture(5));
  await runLinkedInImportJob(known);

  const events = [
    {
      kind: "calendar_event" as const,
      uid: "evt-known",
      summary: "Coffee",
      description: "",
      location: "",
      start: "2024-04-01T15:00:00Z",
      end: "2024-04-01T16:00:00Z",
      attendees: [{ name: "First0 Last0", email: "person0@example.com" }],
      organizer: null,
    },
    {
      kind: "calendar_event" as const,
      uid: "evt-stranger",
      summary: "Webinar",
      description: "",
      location: "",
      start: "2024-04-02T15:00:00Z",
      end: "2024-04-02T16:00:00Z",
      attendees: [{ name: "Nobody Here", email: "nobody@example.com" }],
      organizer: null,
    },
  ];

  const db5 = await getDb();
  const [beforeContacts] = await db5
    .select({ value: count() })
    .from(contacts)
    .where(eq(contacts.userId, USER));

  id = await seedJob(events, "calendar_ics");
  await runImportJobById(id);
  out = await outcome(id);
  check("calendar import completes", out.status === "completed", JSON.stringify(out));
  check("calendar creates nobody", out.created === 0, JSON.stringify(out));
  check("stranger event is skipped", out.skipped === 1, JSON.stringify(out));

  const [afterContacts] = await db5
    .select({ value: count() })
    .from(contacts)
    .where(eq(contacts.userId, USER));
  check(
    "calendar cannot grow the network",
    afterContacts?.value === beforeContacts?.value,
    `${beforeContacts?.value} -> ${afterContacts?.value}`
  );

  const [meetings] = await db5
    .select({ value: count() })
    .from(interactions)
    .where(eq(interactions.userId, USER));
  check("known attendee gets one meeting", (meetings?.value ?? 0) === 1, `rows ${meetings?.value}`);

  // Re-uploading the same file must not double-log the meeting.
  id = await seedJob(events, "calendar_ics");
  await runImportJobById(id);
  const [meetingsAgain] = await db5
    .select({ value: count() })
    .from(interactions)
    .where(eq(interactions.userId, USER));
  check(
    "re-upload logs no duplicate meeting",
    (meetingsAgain?.value ?? 0) === 1,
    `rows ${meetingsAgain?.value}`
  );
```

The free-plan cap is deliberately left in force for this case: the fixture user is on the
free plan, and the point is that a calendar file never consults the cap at all because it
creates nobody.

- [ ] **Step 2: Run to verify it fails**

```bash
npx tsx scripts/smoke-import-engine.ts
```
Expected: FAIL — no `calendar_ics` adapter.

- [ ] **Step 3: Write the adapter and teach the engine `createsContacts: false`**

`identity` returns the attendee probe. The engine matches against the duplicate index and, below the 0.6 floor, marks the row `skipped` rather than creating anything. `toCreate` is required by the type but unreachable — implement it as a thrower, not a plausible-looking contact:

```ts
  toCreate(): ContactInput {
    // Unreachable: `createsContacts: false` means the engine never takes the create
    // branch. Throwing rather than returning something plausible is the point — a calendar
    // file must never be able to add people to a network, and a silent fallback here is
    // exactly how that would happen if the flag were ever dropped.
    throw new Error("calendar import does not create contacts");
  },
```

Follow-up reminder creation moves into the engine's interactions step as a second bulk insert.

- [ ] **Step 4: Rewrite ingest and drop the client chunking**

`confirmCalendarImport` parses and windows events once, writes one job row per event, kicks the job, and returns `{ importId, totalRows }`. Remove the `chunk: { offset, limit }` parameter and the client-side loop that drove it.

- [ ] **Step 5: Verify the whole suite**

```bash
npx tsx scripts/smoke-import-engine.ts
npx tsx scripts/smoke-import-perf.ts
npx tsx scripts/smoke-embedding-backfill.ts
npx tsx scripts/smoke-schema-ddl.ts
npx tsc --noEmit && npm run lint
```

Then run every other smoke script — this phase touched shared write paths, and catching what a targeted test does not is the entire point of them:

```bash
for f in scripts/smoke-*.ts; do echo "== $f"; npx tsx "$f" || echo "FAILED $f"; done
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/import-adapters src/db/schema.ts src/actions/imports.ts src/components/imports scripts/smoke-import-engine.ts
git commit -m "perf: move the calendar import onto the engine as a non-creating adapter"
```

---

## Done when

- `scripts/smoke-import-engine.ts` passes with the same counts it recorded in Task 1
- `scripts/smoke-import-perf.ts` passes, and its per-row statement figure is a fraction of the before-number recorded in Task 2's commit message
- Every other `scripts/smoke-*.ts` passes
- `npx tsc --noEmit` exits 0; `npm run lint` has not gained errors
- No per-row `await` remains inside any import loop
- `imports.stats` carries `durationMs` and `statements` for every completed import
