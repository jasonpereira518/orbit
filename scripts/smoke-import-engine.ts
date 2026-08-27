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
  // Kept under FREE_CONTACT_LIMIT (100) on purpose: this scenario's job is to verify plain,
  // uncapped bulk creation, distinctly from the dedicated cap-boundary scenario below
  // (fixture(140)). The brief originally used fixture(120), which is *above* the cap and
  // so silently turned this into a second, smaller copy of the cap scenario — see
  // task-1-report.md for why that was wrong and how this was corrected.
  await reset();
  let id = await seedJob(fixture(50));
  await runJob(id);
  let out = await outcome(id);
  check("50 fresh rows complete", out.status === "completed", JSON.stringify(out));
  check("50 fresh rows all created", out.created === 50, JSON.stringify(out));
  check("50 fresh rows none merged", out.updated === 0, JSON.stringify(out));
  check("50 fresh rows none blocked", out.blockedByPlan === 0, JSON.stringify(out));

  // --- re-importing the same file merges instead of duplicating ---
  id = await seedJob(fixture(50));
  await runJob(id);
  out = await outcome(id);
  check("re-import merges all 50", out.updated === 50, JSON.stringify(out));
  check("re-import creates none", out.created === 0, JSON.stringify(out));
  check("re-import blocks none", out.blockedByPlan === 0, JSON.stringify(out));

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
