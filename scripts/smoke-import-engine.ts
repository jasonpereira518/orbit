/**
 * Freezes import outcomes across the engine rewrite.
 *
 * Every phase of the import work is allowed to change how many round trips an import
 * costs; none of it is allowed to change how many contacts an import creates, merges,
 * or refuses. This asserts the second thing so the first is safe to change.
 *
 * One environment gap has to be worked around to run `runLinkedInImportJob` headlessly:
 * `revalidatePath`, called once after an import completes, throws "Invariant: static
 * generation store missing" outside a real Next.js request/render. This is a plain
 * limitation of running route-layer code from a script, not a bug in the import engine,
 * so `runJob` below swallows exactly that one invariant message and re-throws anything
 * else — the DB row is already in its final state by the time `revalidatePath` runs,
 * which is what every assertion here checks.
 *
 * Run: npx tsx scripts/smoke-import-engine.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

// Env reads in auth.ts and db/index.ts are lazy (inside functions), so setting these
// after dotenv but before the src/ imports below still lands before anything reads them.
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-import";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-import";
// This suite must run against the local per-worktree PGlite file, never a remote
// database: reset() hard-deletes a user's contacts, and .env.local gaining a
// DATABASE_URL (one `vercel env pull` away) would point that at shared data.
delete process.env.DATABASE_URL;

import crypto from "node:crypto";
import { count, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contacts,
  imports,
  importJobRows,
  userSettings,
  type ImportJobRowPayload,
} from "../src/db/schema";
import { isClerkConfigured, isDemoMode } from "../src/lib/auth";
import { FREE_CONTACT_LIMIT } from "../src/lib/entitlements";
import {
  CHUNK_SIZE,
  MAX_ROW_FAILURES_PER_CHUNK,
  PLAN_LIMIT_ROW_REASON,
} from "../src/lib/import-job-processor";
import { runImportJobById } from "../src/lib/import-job-dispatch";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-import-engine-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/**
 * Runs the job through the shared dispatcher (which resolves the right runner from the
 * job row's own `import_type`, LinkedIn included — see `import-job-dispatch.ts`), tolerating
 * only the `revalidatePath` invariant that fires because this is a bare script rather than a
 * Next.js request. The DB row is already fully updated by the time that call happens, so
 * swallowing it does not hide anything the checks below would otherwise catch. Anything else
 * escapes and fails the run.
 */
async function runJob(importId: string) {
  try {
    await runImportJobById(importId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("Invariant: static generation store missing")) throw err;
  }
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

/**
 * A `company` value the write layer will genuinely refuse — see the "one poisonous row"
 * scenario below for why this, and not a NUL byte, is the poison that actually reaches
 * `writeWithNarrowing`.
 */
function poisonCompany() {
  return crypto.randomBytes(1500).toString("hex");
}

/**
 * Seeds an import plus its job rows directly, skipping CSV/API parsing. Widened to take the
 * import type and any payload shape so the same helper seeds LinkedIn, Google, and Outlook
 * fixtures alike.
 */
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
    rows.map((payload, i) => ({
      importId: job.id,
      userId: USER,
      rowIndex: i,
      payload: payload as ImportJobRowPayload,
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

  // Without this, an environment drift (Clerk keys missing) silently drops the run into
  // demo mode against "demo-user" instead of failing loudly. Running with Clerk configured
  // and demo mode off is also what makes every scenario below a regression test for the
  // *ForUser call sites in import-job-processor.ts: demo mode never exercises the same
  // identity-resolution path the self-continuation route and process-stalled cron use.
  check("running with Clerk configured", isClerkConfigured() === true);
  check("running outside demo mode", isDemoMode() === false);

  // --- all new rows ---
  // Kept well under FREE_CONTACT_LIMIT on purpose: this scenario's job is to verify plain,
  // uncapped bulk creation, distinctly from the dedicated cap-boundary scenario below
  // (fixture(FREE_CONTACT_LIMIT + 40)). The brief originally used fixture(120), which was
  // above the cap in effect at the time and so silently turned this into a second, smaller
  // copy of the cap scenario — see task-1-report.md for why that was wrong and how this
  // was corrected.
  await reset();
  let id = await seedJob(fixture(50));
  await runJob(id);
  let out = await outcome(id);
  check("50 fresh rows complete", out.status === "completed", JSON.stringify(out));
  check("50 fresh rows all created", out.created === 50, JSON.stringify(out));
  check("50 fresh rows none merged", out.updated === 0, JSON.stringify(out));
  check("50 fresh rows none blocked", out.blockedByPlan === 0, JSON.stringify(out));

  // --- created contacts are flagged for the backfill, not embedded inline ---
  // Embeddings moved off the critical path in Task 9: the bulk create path sets
  // `embedding_stale_at` instead of calling the AI provider, and the backfill (Task 8)
  // is what actually clears it. Without this check, a bug that dropped the flag on one
  // of the two bulk paths would leave half of every import silently unsearchable forever
  // and nothing here would catch it.
  {
    const db = await getDb();
    const created = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
    check(
      "every created contact is flagged embedding_stale_at",
      created.length === 50 && created.every((c) => c.embeddingStaleAt !== null),
      `flagged ${created.filter((c) => c.embeddingStaleAt !== null).length}/${created.length}`
    );
  }

  // Clear the flag before re-importing. Without this, the check below would pass even if
  // `bulkMergeContactsForUser` never touched `embedding_stale_at` at all — creation already
  // left every row non-null, and nothing between here and there would clear it, so a
  // non-null read afterward would prove nothing about the merge path specifically. Nulling
  // it here means only the merge itself can make the post-merge check pass.
  {
    const db = await getDb();
    await db
      .update(contacts)
      .set({ embeddingStaleAt: null })
      .where(eq(contacts.userId, USER));
  }

  // --- re-importing the same file merges instead of duplicating ---
  id = await seedJob(fixture(50));
  await runJob(id);
  out = await outcome(id);
  check("re-import merges all 50", out.updated === 50, JSON.stringify(out));
  check("re-import creates none", out.created === 0, JSON.stringify(out));
  check("re-import blocks none", out.blockedByPlan === 0, JSON.stringify(out));

  // --- merges re-stamp the flag on their own: company/title changed, so the stored
  // embedding is genuinely stale again. The flag was nulled immediately above, so a
  // non-null read here can only be explained by bulkMergeContactsForUser itself setting
  // it during this merge, not by a stale leftover from creation. ---
  {
    const db = await getDb();
    const merged = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
    check(
      "every merged contact is (re-)flagged embedding_stale_at",
      merged.length === 50 && merged.every((c) => c.embeddingStaleAt !== null),
      `flagged ${merged.filter((c) => c.embeddingStaleAt !== null).length}/${merged.length}`
    );
  }

  // --- rows with no usable name are skipped, not failed ---
  await reset();
  const withBlank = fixture(10);
  withBlank[3].firstName = "";
  withBlank[3].lastName = "";
  id = await seedJob(withBlank);
  await runJob(id);
  out = await outcome(id);
  check("blank name skipped", out.skipped === 1, JSON.stringify(out));
  check("remaining rows created", out.created === 9, JSON.stringify(out));

  // --- the free plan cap admits from the front and refuses the rest ---
  // Derived from FREE_CONTACT_LIMIT rather than hardcoded so this freezes the *behavior*
  // ("admit up to the cap, refuse the remainder") instead of a specific number — the limit
  // has already changed once (100 here, 500 on origin/main at time of writing).
  await reset();
  id = await seedJob(fixture(FREE_CONTACT_LIMIT + 40));
  await runJob(id);
  out = await outcome(id);
  check(
    `free cap admits ${FREE_CONTACT_LIMIT}`,
    out.created === FREE_CONTACT_LIMIT,
    JSON.stringify(out)
  );
  check("free cap blocks the rest", out.blockedByPlan === 40, JSON.stringify(out));
  check("capped import still completes", out.status === "completed", JSON.stringify(out));

  // --- the cap still binds correctly when it exhausts mid-run and must carry across a
  // chunk boundary, rather than being re-derived (and silently reset) at the top of the
  // next chunk ---
  // `FREE_CONTACT_LIMIT + 40` above collapses to a single chunk at this branch's CHUNK_SIZE,
  // so it never exercises the pre-computed `headroom` option being decremented in one chunk
  // and reused (not reset) in the next — the highest-risk path this task's headroom-hoist
  // change touches. `+ 300` is sized to span multiple chunks under both this branch's cap
  // (100 -> 400 rows -> 2 chunks at CHUNK_SIZE 250) and origin/main's (500 -> 800 rows -> 4
  // chunks), so it stays a real multi-chunk scenario if either constant moves again.
  await reset();
  const multiChunkRows = FREE_CONTACT_LIMIT + 300;
  const observedChunks = Math.ceil(multiChunkRows / CHUNK_SIZE);
  check(
    "multi-chunk cap fixture actually spans more than one chunk",
    observedChunks > 1,
    `rows ${multiChunkRows}, CHUNK_SIZE ${CHUNK_SIZE}, chunks ${observedChunks}`
  );
  console.log(`  multi-chunk cap fixture: ${multiChunkRows} rows across ${observedChunks} chunks`);
  id = await seedJob(fixture(multiChunkRows));
  await runJob(id);
  out = await outcome(id);
  check(
    `multi-chunk cap admits exactly ${FREE_CONTACT_LIMIT} across the chunk boundary`,
    out.created === FREE_CONTACT_LIMIT,
    JSON.stringify(out)
  );
  check(
    "multi-chunk cap blocks the remainder (exhausted headroom carried into the next chunk, not reset)",
    out.blockedByPlan === multiChunkRows - FREE_CONTACT_LIMIT,
    JSON.stringify(out)
  );
  check(
    "multi-chunk capped import still completes",
    out.status === "completed",
    JSON.stringify(out)
  );

  // --- resume is idempotent: a second run adds nothing ---
  const before = out.created;
  await runJob(id);
  const again = await outcome(id);
  check("re-running a finished job is a no-op", again.created === before, JSON.stringify(again));

  // --- a chunk interrupted mid-write must not duplicate on resume ---
  await reset();
  id = await seedJob(fixture(20));
  const db3 = await getDb();
  await runJob(id);
  // Simulate a crash after contacts were inserted but before rows were marked done: the
  // rows sit in `processing`, which is exactly the state the claim step leaves behind.
  await db3
    .update(importJobRows)
    .set({ status: "processing" })
    .where(eq(importJobRows.importId, id));
  await db3.update(imports).set({ status: "processing" }).where(eq(imports.id, id));
  await runJob(id);
  const [resumed] = await db3
    .select({ value: count() })
    .from(contacts)
    .where(eq(contacts.userId, USER));
  check(
    "resuming a half-written chunk merges rather than duplicates",
    (resumed?.value ?? 0) === 20,
    `contacts: ${resumed?.value}`
  );
  // The count assertion above passes trivially if the resumed job just leaves the rows
  // stuck in `processing` and never touches them again — 20 unchanged either way. These
  // two checks rule that out: the rows must actually reach a terminal status, and they
  // must get there via the merge path (`duplicatesFound`), not by being silently ignored.
  const resumedRows = await db3.query.importJobRows.findMany({
    where: eq(importJobRows.importId, id),
  });
  check(
    "resumed rows reach a terminal status instead of staying stuck in processing",
    resumedRows.every((row) => row.status === "done"),
    JSON.stringify(resumedRows.map((row) => row.status))
  );
  const resumedOutcome = await outcome(id);
  const resumedRow = await db3.query.imports.findFirst({ where: eq(imports.id, id) });
  check(
    "resumed rows were actually re-run through the duplicate index and merged",
    resumedRow?.duplicatesFound === 20,
    `duplicatesFound: ${resumedRow?.duplicatesFound}, ${JSON.stringify(resumedOutcome)}`
  );

  // --- one poisonous row must not take the whole import with it (create path) ---
  // The brief's suggested poison — a NUL byte in `firstName` — turns out to be inert here
  // for the wrong-but-instructive reason: `import_job_rows.payload` is `jsonb`, and
  // Postgres's own JSON parser refuses an embedded NUL byte ("unsupported Unicode escape
  // sequence") before the row can even be seeded, let alone reach the create/merge write
  // this task narrows. Confirmed by hand: seeding one row with
  // `firstName: "bad" + String.fromCharCode(0) + "name"` throws at `seedJob` time, never
  // reaching `runImportJob` at all — so it would prove nothing about narrowing.
  //
  // A value that fails only at the actual write, and only for this one row, has to be
  // something Postgres accepts as JSON text but refuses when it lands somewhere indexed.
  // `poisonCompany()` is an incompressible (crypto-random, so PGLZ/TOAST can't shrink it)
  // ~3000-character string. It does not fail on the `contacts` insert itself — it fails one
  // step earlier, in `resolveCompany`'s `INSERT INTO companies`, which is keyed by
  // `companies_user_name_uidx` on `(user_id, name_normalized)`; `normalizeCompanyName` only
  // lowercases and collapses whitespace, so the value reaches that unique btree index at
  // full length and clears its hard ~2704-byte entry ceiling. `resolveCompany`'s own
  // find-or-create race handler swallows the raw Postgres error and re-throws
  // `Could not resolve company: <value>`, which is the error `writeWithNarrowing` actually
  // catches. Confirmed by hand with a length sweep against a real insert (compressible
  // `'x'.repeat(n)` values never triggered it — TOAST compresses them away, hence the
  // crypto-random bytes here). The other 29 rows keep their normal, short company values and
  // resolve/insert cleanly.
  await reset();
  const poisoned = fixture(30);
  poisoned[7].company = poisonCompany();
  id = await seedJob(poisoned);
  await runJob(id);
  out = await outcome(id);
  check("import survives a bad row", out.status === "completed", JSON.stringify(out));
  check("good rows still land", out.created === 29, JSON.stringify(out));
  {
    const db = await getDb();
    const rows = await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, id) });
    const bad = rows.find((r) => r.rowIndex === 7);
    const rest = rows.filter((r) => r.rowIndex !== 7);
    check(
      "the poisoned row alone is marked failed with a message",
      bad?.status === "failed" && typeof bad.errorMessage === "string" && bad.errorMessage.length > 0,
      JSON.stringify(bad)
    );
    check(
      "every other row reached a terminal done status",
      rest.every((r) => r.status === "done"),
      JSON.stringify(rest.map((r) => r.status))
    );
  }

  // --- one poisonous row must not take the whole import with it (merge path) ---
  // The create-path scenario above never touches `bulkMergeContactsForUser` — every row
  // there is a fresh identity, so `toUpdate` is always empty. Narrowing is wired into both
  // batches (see `runImportJob`), and this is the committed proof for the second one: seed
  // 30 clean contacts first, then re-import the *same* identities (so every row lands in
  // `toUpdate`, not `toCreate`) with one row's `company` poisoned the same way.
  await reset();
  id = await seedJob(fixture(30));
  await runJob(id);
  out = await outcome(id);
  check("merge fixture: 30 fresh rows all created", out.created === 30, JSON.stringify(out));

  const remerged = fixture(30);
  remerged[7].company = poisonCompany();
  id = await seedJob(remerged);
  await runJob(id);
  out = await outcome(id);
  check("merge survives a bad row", out.status === "completed", JSON.stringify(out));
  check("good rows still merge", out.updated === 29, JSON.stringify(out));
  check("no rows are (re-)created by the merge pass", out.created === 0, JSON.stringify(out));
  {
    const db = await getDb();
    const rows = await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, id) });
    const bad = rows.find((r) => r.rowIndex === 7);
    const rest = rows.filter((r) => r.rowIndex !== 7);
    check(
      "the poisoned merge row alone is marked failed with a message",
      bad?.status === "failed" && typeof bad.errorMessage === "string" && bad.errorMessage.length > 0,
      JSON.stringify(bad)
    );
    check(
      "every other merge row reached a terminal done status",
      rest.every((r) => r.status === "done"),
      JSON.stringify(rest.map((r) => r.status))
    );
  }

  // --- the plan cap and narrowing must not confuse each other's accounting when both bind
  // in the same chunk ---
  // The cap-boundary scenario earlier in this file never has a poisoned row, and the
  // poison scenarios above never approach the cap, so nothing committed so far exercises a
  // chunk where `createContactsBulkForUser` both refuses a tail *and* one of the rows it
  // would have admitted is poisoned. `headroom` is decremented inside the same closure that
  // narrowing retries on smaller slices (see `runImportJob`), so this is exactly the kind of
  // interaction that's "right by accident" until something moves it.
  //
  // Headroom is pinned to 10 by inserting 90 filler contacts directly (bypassing the import
  // path entirely, so they cost no chunk statements and can't themselves be poisoned).
  // 20 fresh rows follow, with row 3 — inside the cap's admitted prefix — poisoned. Expected,
  // and verified by hand before committing this: rows 0,1,2 are admitted, row 3 is isolated
  // and marked failed *without* consuming headroom, rows 4-10 fill the remaining headroom
  // (10 created total), and rows 11-19 are refused by the now-exhausted cap.
  await reset();
  {
    const db = await getDb();
    const filler = Array.from({ length: FREE_CONTACT_LIMIT - 10 }, (_, i) => ({
      userId: USER,
      fullName: `Filler ${i}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    await db.insert(contacts).values(filler);
  }
  const capAndPoison = fixture(20);
  capAndPoison[3].company = poisonCompany();
  id = await seedJob(capAndPoison);
  await runJob(id);
  out = await outcome(id);
  check("cap+poison: import still completes", out.status === "completed", JSON.stringify(out));
  check("cap+poison: created exactly fills headroom (10)", out.created === 10, JSON.stringify(out));
  check("cap+poison: cap blocks exactly the rest (9)", out.blockedByPlan === 9, JSON.stringify(out));
  {
    const db = await getDb();
    const rows = await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, id) });
    const byIndex = new Map(rows.map((r) => [r.rowIndex, r]));
    const poisonedRow = byIndex.get(3);
    check(
      "cap+poison: the poisoned row is marked failed, not blocked",
      poisonedRow?.status === "failed" &&
        typeof poisonedRow.errorMessage === "string" &&
        poisonedRow.errorMessage.length > 0,
      JSON.stringify(poisonedRow)
    );
    const admitted = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10];
    const blocked = [11, 12, 13, 14, 15, 16, 17, 18, 19];
    check(
      "cap+poison: rows admitted under the cap are done",
      admitted.every((i) => byIndex.get(i)?.status === "done"),
      JSON.stringify(admitted.map((i) => byIndex.get(i)?.status))
    );
    check(
      "cap+poison: rows past the cap are skipped for the plan-limit reason",
      blocked.every(
        (i) =>
          byIndex.get(i)?.status === "skipped" &&
          byIndex.get(i)?.errorMessage === PLAN_LIMIT_ROW_REASON
      ),
      JSON.stringify(blocked.map((i) => byIndex.get(i)?.status))
    );
  }

  // --- a chunk with more genuinely bad rows than MAX_ROW_FAILURES_PER_CHUNK must not mark
  // every one of them failed ---
  // Without a budget, `writeWithNarrowing` cannot distinguish "this chunk has a lot of
  // scattered bad data" from "this chunk hit one systemic fault that makes every row throw" —
  // both look identical from inside a single `write` call. The second shape must fail the
  // *import*, leaving rows `processing` and reclaimable, not permanently mark dozens of
  // otherwise-fine rows `failed` for a transient reason. This is simulated the only way
  // available outside a real driver fault: poisoning more rows in one chunk than the budget
  // allows, which exercises the exact code path a systemic fault would also hit (`onBadRow`
  // throwing instead of marking).
  //
  // `writeWithNarrowing` always finishes the left half of a split before starting the right
  // half (see its own comment on why), so across the whole chunk it isolates bad rows in
  // strictly increasing `rowIndex` order. With rows 0 through MAX_ROW_FAILURES_PER_CHUNK
  // (inclusive — one past the budget) all poisoned, that guarantees exactly the first
  // MAX_ROW_FAILURES_PER_CHUNK of them get marked `failed` before the next one aborts the
  // whole chunk — verified by hand before committing this, not just asserted here.
  await reset();
  const overBudget = fixture(MAX_ROW_FAILURES_PER_CHUNK + 30);
  for (let i = 0; i <= MAX_ROW_FAILURES_PER_CHUNK; i++) {
    overBudget[i].company = poisonCompany();
  }
  id = await seedJob(overBudget);
  await runJob(id);
  out = await outcome(id);
  check(
    "over-budget chunk fails the import instead of the whole chunk's rows",
    out.status === "failed",
    JSON.stringify(out)
  );
  check("over-budget chunk creates nothing", out.created === 0, JSON.stringify(out));
  {
    const db = await getDb();
    const rows = await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, id) });
    const failedRows = rows.filter((r) => r.status === "failed");
    const processingRows = rows.filter((r) => r.status === "processing");
    check(
      `over-budget chunk marks exactly MAX_ROW_FAILURES_PER_CHUNK (${MAX_ROW_FAILURES_PER_CHUNK}) rows failed, not every bad row`,
      failedRows.length === MAX_ROW_FAILURES_PER_CHUNK,
      `failed: ${failedRows.length}, rowIndexes: ${JSON.stringify(failedRows.map((r) => r.rowIndex).sort((a, b) => a - b))}`
    );
    check(
      "over-budget chunk's remaining rows stay processing (reclaimable), not failed",
      processingRows.length === rows.length - MAX_ROW_FAILURES_PER_CHUNK,
      `processing: ${processingRows.length}, total: ${rows.length}`
    );
    check(
      "no row silently reached done or skipped once the budget aborted the chunk",
      rows.every((r) => r.status === "failed" || r.status === "processing"),
      JSON.stringify(rows.map((r) => r.status))
    );
  }

  // --- Google contacts run the same engine, keyed on email ---
  // Google/Outlook rows carry no LinkedIn URL, and often no email at all — most of this
  // fixture keeps one so it can freeze the "re-import merges" behavior specifically, but
  // row 6 deliberately has neither email, company, nor title (name only), to freeze the
  // *other* documented behavior: a name-only row's identity() still returns a probe (just
  // fullName), which can only match on the weak byName tier (0.6 confidence, below the 0.85
  // merge floor) — so it creates again on re-import instead of merging. Company/title also
  // have to be blanked, not just email: duplicates.ts's byNameCompany/byNameTitle tiers
  // (0.9/0.85) fire on an exact company or title match too, and this row's company/title
  // would otherwise exactly match its own first-run contact on the second import, masking
  // the weak-tier behavior this row exists to freeze. See the "no dropped identity for
  // no-email rows" reasoning in src/lib/import-adapters/google-contacts.ts. A name-only row
  // still gets exercised above too: the blank-name row (index 5) proves the no-identity skip
  // path works the same way it does for LinkedIn.
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
  google[6].email = "";
  google[6].company = "";
  google[6].title = "";

  id = await seedJob(google, "google_contacts");
  await runJob(id);
  out = await outcome(id);
  check("google import completes", out.status === "completed", JSON.stringify(out));
  check("google creates all but the nameless row", out.created === 39, JSON.stringify(out));
  check("google skips the nameless row", out.skipped === 1, JSON.stringify(out));

  // Re-running the same export must merge on email, not duplicate — except the no-email
  // row, which has no strong-enough identity to merge confidently and creates again.
  id = await seedJob(google, "google_contacts");
  await runJob(id);
  out = await outcome(id);
  check("google re-import merges every row with an email", out.updated === 38, JSON.stringify(out));
  check(
    "google re-import creates the no-email row again instead of merging it",
    out.created === 1,
    JSON.stringify(out)
  );

  // --- Outlook contacts: same engine, same email-keyed identity, different payload shape ---
  // Same name-only row as the Google fixture above (row 6, no email/company/title) — see
  // that block's comment for why it must create again on re-import rather than merge.
  await reset();
  const outlook = Array.from({ length: 40 }, (_, i) => ({
    kind: "outlook_contact" as const,
    id: `AAMk${i}`,
    fullName: `Outlook Person ${i}`,
    firstName: "Outlook",
    lastName: `Person ${i}`,
    company: `Company ${i % 6}`,
    title: `Title ${i % 4}`,
    email: `outlook${i}@example.com`,
    phone: "",
  }));
  outlook[5].fullName = "   ";
  outlook[6].email = "";
  outlook[6].company = "";
  outlook[6].title = "";

  id = await seedJob(outlook, "outlook_contacts");
  await runJob(id);
  out = await outcome(id);
  check("outlook import completes", out.status === "completed", JSON.stringify(out));
  check("outlook creates all but the nameless row", out.created === 39, JSON.stringify(out));
  check("outlook skips the nameless row", out.skipped === 1, JSON.stringify(out));

  id = await seedJob(outlook, "outlook_contacts");
  await runJob(id);
  out = await outcome(id);
  check("outlook re-import merges every row with an email", out.updated === 38, JSON.stringify(out));
  check(
    "outlook re-import creates the no-email row again instead of merging it",
    out.created === 1,
    JSON.stringify(out)
  );

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
