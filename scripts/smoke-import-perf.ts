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

// Env reads in auth.ts and db/index.ts are lazy (inside functions), so setting these
// after dotenv but before the src/ imports below still lands before anything reads them.
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-import";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-import";
// This suite must run against the local per-worktree PGlite file, never a remote
// database: this script hard-deletes a user's contacts, and .env.local gaining a
// DATABASE_URL (one `vercel env pull` away) would point that at shared data.
delete process.env.DATABASE_URL;

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, imports, importJobRows, userSettings } from "../src/db/schema";
import { isClerkConfigured, isDemoMode } from "../src/lib/auth";
import { CHUNK_SIZE, runLinkedInImportJob } from "../src/lib/import-job-processor";
import { startQueryCount, stopQueryCount } from "../src/lib/query-counter";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-import-perf-user";
const ROWS = 500;

// A fresh import is overwhelmingly creates, so the fixture must not accidentally manufacture
// duplicates. An earlier version used `Perf${i} Person${i}` names: consecutive numeric
// suffixes (e.g. "Perf100 Person100" vs "Perf400 Person400") sit right at the fuzzy-name
// threshold (nameSimilarity >= 0.88, see src/lib/duplicates.ts), and `company: i % 30` /
// `title: i % 12` supplied the same-company/same-title condition that tier also requires —
// together they made most of the 500 rows resolve as merges instead of creates, which is not
// the workload this guard exists to bound. FIRST_NAMES/LAST_NAMES below are real, distinct
// words (not shared numeric stems) so no two of the 500 generated full names come close to
// the fuzzy threshold; COMPANY_MOD/TITLE_MOD are primes unrelated to the name grid so company
// and title never happen to realign with it either.
const FIRST_NAMES = [
  "Olivia", "Liam", "Emma", "Noah", "Ava", "Ethan", "Sophia", "Mason",
  "Isabella", "Lucas", "Mia", "Elijah", "Amelia", "Oliver", "Harper",
  "Benjamin", "Evelyn", "James", "Abigail", "Henry", "Emily", "Alexander",
  "Ella", "Michael", "Scarlett",
];
const LAST_NAMES = [
  "Nguyen", "Garcia", "Patel", "Kowalski", "Johansson", "Okafor", "Silva",
  "Andersson", "Tanaka", "Kim", "Rossi", "Dubois", "Haddad", "Novak",
  "Larsen", "Petrov", "Costa", "Ibrahim", "Fischer", "Yamada",
];
const COMPANY_MOD = 41;
const TITLE_MOD = 17;

/** One fixture row: a genuinely distinct person, not a numeric variation on the same name. */
function fixtureRow(i: number) {
  // (i % 25, floor(i / 25)) is a bijection over the 500-row range onto the full 25x20 name
  // grid, so every (firstName, lastName) pair below is used exactly once — no repeats.
  const firstName = FIRST_NAMES[i % FIRST_NAMES.length];
  const lastName = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length];
  return {
    index: i,
    firstName,
    lastName,
    email: `perf${i}@example.com`,
    company: `Company ${i % COMPANY_MOD}`,
    position: `Title ${i % TITLE_MOD}`,
    connectedOn: "15 Mar 2024",
    url: `https://www.linkedin.com/in/perf-person-${i}`,
  };
}

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

  // Without this, an environment drift (Clerk keys missing) silently drops the run into
  // demo mode against "demo-user" instead of failing loudly.
  check("running with Clerk configured", isClerkConfigured() === true);
  check("running outside demo mode", isDemoMode() === false);

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

  // Cleanup runs in `finally` so a failed budget check (this guard's entire documented
  // purpose, and its expected state through several of the tasks that follow) still
  // leaves no fixture data behind under USER.
  try {
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
        payload: fixtureRow(i),
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
  } finally {
    await db.delete(contacts).where(eq(contacts.userId, USER));
    await db.delete(imports).where(eq(imports.userId, USER));
    await db.delete(userSettings).where(eq(userSettings.userId, USER));
  }
  console.log("\nRound-trip budget respected.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
