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

/**
 * Runs the job, tolerating only the `revalidatePath` invariant that fires because this is
 * a bare script rather than a Next.js request (see `scripts/smoke-import-engine.ts`'s
 * `runJob` for the same workaround). The DB row is already in its final state by the time
 * that call happens, so swallowing it does not affect the statement count already taken.
 */
async function runJob(importId: string) {
  try {
    await runLinkedInImportJob(importId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("Invariant: static generation store missing")) throw err;
  }
}

async function main() {
  console.log("Import round-trip budget (pglite)...");

  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await ensureUserSettings(USER);
  // The free cap would refuse most of the fixture and the import would end early, measuring
  // nothing. Comp the user to a paid plan so the whole fixture is processed (`compedPlan`
  // only accepts "orbit" | "lifetime" — see src/db/schema.ts).
  await db
    .update(userSettings)
    .set({ compedPlan: "orbit" })
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
  await runJob(job.id);
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
