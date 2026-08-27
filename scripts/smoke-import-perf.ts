/**
 * Guards the round-trip cost of a bulk import, for both paths a row can take.
 *
 * The import path is fast only as long as its statements are per-chunk, not per-row. That
 * property is invisible in behavior — a per-row `await` in a loop returns exactly the same
 * contacts, just fifty times slower — so nothing but a count can defend it.
 *
 * Two phases, two separate budgets:
 *   1. 500 fresh rows, all creates.
 *   2. The same 500 rows imported again into a second job, all matching the phase-1
 *      contacts on `linkedinUrl` (0.98 confidence — an exact identity match, not a fuzzy
 *      near-match), so every row takes the merge path.
 *
 * These are asserted separately, not combined into one figure. A combined budget would let
 * a per-row regression in either path hide behind headroom borrowed from the other — which
 * is exactly what happened here: an earlier version of this fixture generated its own
 * accidental duplicates (see FIRST_NAMES/LAST_NAMES below), so the single number it produced
 * was almost entirely the cost of that unintended merge traffic, and a genuinely create-only
 * workload had never actually been measured, nor had merges been measured on their own.
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

// The fixture must not accidentally manufacture duplicates in phase 1, nor rely on
// accidental collisions to manufacture them in phase 2. An earlier version used
// `Perf${i} Person${i}` names: consecutive numeric suffixes (e.g. "Perf100 Person100" vs
// "Perf400 Person400") sit right at the fuzzy-name threshold (nameSimilarity >= 0.88, see
// src/lib/duplicates.ts), and `company: i % 30` / `title: i % 12` supplied the
// same-company/same-title condition that tier also requires — together they made most of
// the 500 rows resolve as merges when only a single, undifferentiated phase existed, which
// was never the workload that phase was meant to measure. FIRST_NAMES/LAST_NAMES below are
// real, distinct words (not shared numeric stems) so no two of the 500 generated full names
// come close to the fuzzy threshold in phase 1; COMPANY_MOD/TITLE_MOD are primes unrelated
// to the name grid so company and title never happen to realign with it either. Phase 2's
// merges are deliberate instead, driven by re-submitting the identical `linkedinUrl` values,
// which is an exact-identity match (0.98 confidence) — not something that depends on any of
// the above staying accidentally uncorrelated.
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

const CHUNKS = Math.ceil(ROWS / CHUNK_SIZE);
/**
 * Job-level setup (contact load, company preload, final recalibration) is not per-chunk,
 * so it gets its own small allowance rather than inflating either per-chunk budget.
 */
const JOB_OVERHEAD = 20;

/**
 * Statements a chunk of pure creates may cost, end to end. Derived from the spec's budget
 * table (~10) with headroom for driver-level chatter. Raising this number is a design
 * decision, not a test fix — if a change needs more, say why in the commit message.
 */
const BUDGET_PER_CHUNK_CREATE = 14;
const CREATE_BUDGET = CHUNKS * BUDGET_PER_CHUNK_CREATE + JOB_OVERHEAD;

/**
 * Statements a chunk of pure merges may cost. A merge chunk skips the create-side bulk
 * insert and tag sync entirely, so this is deliberately a different (lower) number than
 * the create budget rather than reusing it. Measured at ~6.5/chunk (105 statements over 13
 * chunks) for the bulk single-statement merge (`bulkMergeContactsForUser`); 9 keeps
 * proportionally the same headroom over that measurement as `BUDGET_PER_CHUNK_CREATE` keeps
 * over its own (~157 actual / 202 budget). Raising it is a design decision, not a test fix.
 */
const BUDGET_PER_CHUNK_MERGE = 9;
const MERGE_BUDGET = CHUNKS * BUDGET_PER_CHUNK_MERGE + JOB_OVERHEAD;

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

/**
 * Seeds one import job with `payloads` under fresh `import_job_rows` (never reusing a
 * prior job's rows, which are already marked `done` and would be skipped as not-pending),
 * runs it, and returns the statement count plus the job's own recorded counters.
 */
async function runPhase(payloads: ReturnType<typeof fixtureRow>[], fileName: string) {
  const db = await getDb();
  const [job] = await db
    .insert(imports)
    .values({
      userId: USER,
      importType: "linkedin_connections",
      fileName,
      status: "processing",
      totalRows: payloads.length,
      stats: {},
    })
    .returning();

  await db.insert(importJobRows).values(
    payloads.map((payload, i) => ({
      importId: job.id,
      userId: USER,
      rowIndex: i,
      payload,
    }))
  );

  startQueryCount();
  await runJob(job.id);
  const used = stopQueryCount();

  const finished = await db.query.imports.findFirst({ where: eq(imports.id, job.id) });
  return { used, finished };
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

  const payloads = Array.from({ length: ROWS }, (_, i) => fixtureRow(i));

  // Cleanup runs in `finally` so a failed budget check (this guard's entire documented
  // purpose for whichever phase is currently expected to fail) still leaves no fixture
  // data behind under USER.
  try {
    // Phase 1: 500 fresh rows, all creates.
    const createPhase = await runPhase(payloads, "perf-creates.csv");
    console.log(
      `  statements-for-500-creates: ${createPhase.used} (${CHUNKS} chunks; budget ${CREATE_BUDGET})`
    );
    check(
      "phase 1 stays within its create budget",
      createPhase.used <= CREATE_BUDGET,
      `used ${createPhase.used}, allowed ${CREATE_BUDGET} (${(createPhase.used / ROWS).toFixed(1)} per row)`
    );
    check(
      "phase 1 created 500 and updated none",
      createPhase.finished?.contactsCreated === ROWS &&
        createPhase.finished?.contactsUpdated === 0,
      `created ${createPhase.finished?.contactsCreated}, updated ${createPhase.finished?.contactsUpdated}`
    );

    const afterPhase1 = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
    check(
      "500 contacts exist after phase 1",
      afterPhase1.length === ROWS,
      `found ${afterPhase1.length}`
    );

    // Phase 2: the *same* 500 payloads, submitted as a second job. Every row's `linkedinUrl`
    // exactly matches a phase-1 contact, so every row takes the merge path (0.98 confidence
    // — an exact-identity tier, not the fuzzy-name tier that caused the original problem).
    const mergePhase = await runPhase(payloads, "perf-merges.csv");
    console.log(
      `  statements-for-500-merges: ${mergePhase.used} (${CHUNKS} chunks; budget ${MERGE_BUDGET})`
    );
    check(
      "phase 2 stays within its merge budget",
      mergePhase.used <= MERGE_BUDGET,
      `used ${mergePhase.used}, allowed ${MERGE_BUDGET} (${(mergePhase.used / ROWS).toFixed(1)} per row)`
    );
    check(
      "phase 2 updated 500 and created none",
      mergePhase.finished?.contactsUpdated === ROWS &&
        mergePhase.finished?.contactsCreated === 0,
      `created ${mergePhase.finished?.contactsCreated}, updated ${mergePhase.finished?.contactsUpdated}`
    );

    const afterPhase2 = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
    check(
      "still 500 contacts after phase 2 (merges, not duplicate creates)",
      afterPhase2.length === ROWS,
      `found ${afterPhase2.length}`
    );
  } finally {
    await db.delete(contacts).where(eq(contacts.userId, USER));
    await db.delete(imports).where(eq(imports.userId, USER));
    await db.delete(userSettings).where(eq(userSettings.userId, USER));
  }
  console.log("\nRound-trip budgets respected.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
