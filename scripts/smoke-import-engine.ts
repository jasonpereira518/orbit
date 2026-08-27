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

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, imports, importJobRows, userSettings } from "../src/db/schema";
import { isClerkConfigured, isDemoMode } from "../src/lib/auth";
import { FREE_CONTACT_LIMIT } from "../src/lib/entitlements";
import { CHUNK_SIZE, runLinkedInImportJob } from "../src/lib/import-job-processor";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-import-engine-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/**
 * Runs the job, tolerating only the `revalidatePath` invariant that fires because this
 * is a bare script rather than a Next.js request. The DB row is already fully updated by
 * the time that call happens, so swallowing it does not hide anything the checks below
 * would otherwise catch. Anything else escapes and fails the run.
 */
async function runJob(importId: string) {
  try {
    await runLinkedInImportJob(importId);
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

  // --- re-importing the same file merges instead of duplicating ---
  id = await seedJob(fixture(50));
  await runJob(id);
  out = await outcome(id);
  check("re-import merges all 50", out.updated === 50, JSON.stringify(out));
  check("re-import creates none", out.created === 0, JSON.stringify(out));
  check("re-import blocks none", out.blockedByPlan === 0, JSON.stringify(out));

  // --- merged contacts are re-flagged too: company/title changed, so the stored
  // embedding (if any had been backfilled) is genuinely stale again ---
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
