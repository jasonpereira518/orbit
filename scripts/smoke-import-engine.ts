/**
 * Freezes import outcomes across the engine rewrite.
 *
 * Every phase of the import work is allowed to change how many round trips an import
 * costs; none of it is allowed to change how many contacts an import creates, merges,
 * or refuses. This asserts the second thing so the first is safe to change.
 *
 * Two environment gaps had to be worked around to run `runLinkedInImportJob` headlessly
 * (neither is a source change — both are documented in the report for task 1):
 *
 *  - `createContactsBulk`/`updateContact` (imported from `@/actions/contacts`, not the
 *    `*ForUser` variants) resolve their acting identity through `requireUserId()`, which
 *    reads an ambient Clerk session. Outside a real request there is no session, so
 *    without Clerk configured this throws `UnauthorizedError`; the only way it *can*
 *    succeed from a bare script is demo mode, which always resolves to the literal
 *    "demo-user" regardless of who owns the import row. So `USER` below is "demo-user"
 *    (not an arbitrary fixture string) — anything else would make the import's own
 *    duplicate-index lookup (scoped to `imports.userId`) disagree with the identity the
 *    writes actually land under, and merges would silently stop matching.
 *  - `revalidatePath`, called once after an import completes, throws
 *    "Invariant: static generation store missing" outside a real Next.js request/render.
 *    This is a plain limitation of running route-layer code from a script, not a bug in
 *    the import engine, so `runJob` below swallows exactly that one invariant message and
 *    re-throws anything else — the DB row is already in its final state by the time
 *    `revalidatePath` runs, which is what every assertion here checks.
 *
 * Run: NODE_ENV=development npx tsx scripts/smoke-import-engine.ts
 */
// `NODE_ENV` is typed read-only (Next's global augmentation); route the write through an
// untyped view of `process.env` rather than widening the type everywhere else.
(process.env as Record<string, string | undefined>).NODE_ENV = "development";
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, imports, importJobRows, userSettings } from "../src/db/schema";
import { runLinkedInImportJob } from "../src/lib/import-job-processor";
import { ensureUserSettings } from "../src/lib/user-settings";

// See the file header: this must be the literal Clerk demo-mode identity, not an
// arbitrary fixture string, or writes and duplicate lookups resolve to different users.
const USER = "demo-user";

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

  // --- all new rows ---
  // NOTE: 120 > FREE_CONTACT_LIMIT (100). The brief assumed all 120 fresh rows would be
  // created on a fresh free-plan account, but the plan cap applies here exactly as it
  // does in the dedicated cap scenario below: a fresh account only has 100 rows of
  // headroom, so 100 are created and the remaining 20 are blocked by plan, not created.
  // This is corrected behavior, not a relaxed assertion — see task-1-report.md.
  await reset();
  let id = await seedJob(fixture(120));
  await runJob(id);
  let out = await outcome(id);
  check("120 fresh rows complete", out.status === "completed", JSON.stringify(out));
  check("120 fresh rows create up to the free cap", out.created === 100, JSON.stringify(out));
  check("120 fresh rows none merged", out.updated === 0, JSON.stringify(out));
  check("120 fresh rows: the other 20 are blocked by plan", out.blockedByPlan === 20, JSON.stringify(out));

  // --- re-importing the same file merges instead of duplicating ---
  // Only the 100 rows actually created above have a duplicate to match against; the other
  // 20 were never created, so re-importing them is indistinguishable from importing them
  // for the first time — they hit the (still full) cap again rather than merging.
  id = await seedJob(fixture(120));
  await runJob(id);
  out = await outcome(id);
  check("re-import merges the 100 that exist", out.updated === 100, JSON.stringify(out));
  check("re-import creates none", out.created === 0, JSON.stringify(out));
  check("re-import blocks the 20 that were never created", out.blockedByPlan === 20, JSON.stringify(out));

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
  await reset();
  id = await seedJob(fixture(140));
  await runJob(id);
  out = await outcome(id);
  check("free cap admits 100", out.created === 100, JSON.stringify(out));
  check("free cap blocks the rest", out.blockedByPlan === 40, JSON.stringify(out));
  check("capped import still completes", out.status === "completed", JSON.stringify(out));

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
