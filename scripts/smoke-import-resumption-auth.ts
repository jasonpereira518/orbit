/**
 * Regression test for the import-resumption auth bug.
 *
 * `runLinkedInImportJob` used to write through `createContactsBulk`/`updateContact` from
 * `@/actions/contacts` — the request-scoped wrappers, which resolve their acting identity
 * through `requireUserId()` and so need an ambient Clerk session. The processor has two
 * resumption paths, and neither has one; both are authorized by `CRON_SECRET` alone:
 *
 *   - `scheduleContinuation()` -> `POST /api/imports/[id]/continue`, used whenever an
 *     import exceeds `TIME_BUDGET_MS` in one invocation and must continue itself.
 *   - `GET /api/imports/process-stalled`, the daily cron backstop.
 *
 * In production (Clerk configured, so demo mode off) both threw `UnauthorizedError`, which
 * the processor's own catch turned into `failImport` — a `status: "failed"` import with
 * nothing wrong with the data. Only imports finishing inside their original Server Action
 * request ever succeeded. The processor now calls `createContactsBulkForUser` /
 * `updateContactForUser` with `importRow.userId`, which is already in scope, so it does not
 * consult ambient auth at all.
 *
 * This script runs in the exact shape that used to fail: Clerk keys present
 * (`isDemoMode()` false, `isClerkConfigured()` true) and no request, so `auth()` cannot
 * resolve a user. Against the pre-fix processor it fails on the first scenario with
 * `{"status":"failed","created":0,"error":"Unauthorized"}`.
 *
 * Scope note: this deliberately does NOT re-assert import counts, merge/skip/cap outcomes,
 * or any other frozen behavior — `scripts/smoke-import-engine.ts` is the contract for that.
 * The one thing here that looks like behavior coverage is the re-import/merge scenario, and
 * it is not optional: the fix changed *two* call sites, and a create-only run never reaches
 * `updateContactForUser`. The merge case exists to execute that second line under the same
 * session-less auth, not to freeze how merging behaves.
 *
 * `revalidatePath`, called once after an import completes, throws "Invariant: static
 * generation store missing" outside a real Next.js request/render. That is a limitation of
 * running route-layer code from a script, not a bug in the import engine, so `runJob` below
 * swallows exactly that one invariant and re-throws anything else — the DB row is already
 * in its final state by the time `revalidatePath` runs.
 *
 * Run: npx tsx scripts/smoke-import-resumption-auth.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

// Force the local PGlite database, explicitly rather than by hoping DATABASE_URL is absent.
// `getDb()` picks PGlite exactly when DATABASE_URL is unset, and this repo's .env.local sets
// it to a shared remote Neon URL — so without this delete, `reset()` below would hard-delete
// rows in that remote database. dotenv only fills in *unset* vars, so this must run after it.
delete process.env.DATABASE_URL;

// Reproduce the production auth shape the resumption paths actually run in: Clerk configured
// (so `isDemoMode()` is false) but no request, so `auth()` resolves no user. These are never
// used to talk to Clerk — only to steer `isDemoMode()` / `isClerkConfigured()`.
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-import-resumption-auth";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-import-resumption-auth";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, imports, importJobRows, userSettings } from "../src/db/schema";
import { runImportJobById } from "../src/lib/import-job-dispatch";
import { isClerkConfigured, isDemoMode } from "../src/lib/auth";
import { ensureUserSettings } from "../src/lib/user-settings";

/** Private fixture identity — never the shared "demo-user", whose rows are real seed data. */
const USER = "smoke-import-resumption-auth-user";

/** Matches what `failImport` records when `requireUserId()` rejects. */
const AUTH_ERROR = /Authentication is required|Unauthorized/i;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** Resumption goes through the dispatcher, which is what both routes call. */
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

function fixture(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    firstName: `First${i}`,
    lastName: `Last${i}`,
    email: `person${i}@example.com`,
    company: `Company ${i % 5}`,
    position: `Title ${i % 3}`,
    connectedOn: "15 Mar 2024",
    url: `https://www.linkedin.com/in/person-${i}`,
  }));
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
    rows.map((payload, i) => ({ importId: job.id, userId: USER, rowIndex: i, payload }))
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
    error: row.errorMessage ?? null,
  };
}

async function main() {
  console.log("Import resumption auth regression (pglite, no Clerk session)...");

  // If either of these flipped, the run would fall back to demo mode's "demo-user" and
  // stop testing the session-less path at all — every assertion below would pass vacuously.
  check("running with Clerk configured", isClerkConfigured() === true);
  check("running outside demo mode", isDemoMode() === false);

  // --- creation path: covers createContactsBulkForUser ---
  await reset();
  let id = await seedJob(fixture(20));
  await runJob(id);
  let out = await outcome(id);
  check("session-less create does not fail", out.status !== "failed", JSON.stringify(out));
  check(
    "session-less create records no auth error",
    !AUTH_ERROR.test(out.error ?? ""),
    JSON.stringify(out)
  );
  check("session-less create completes", out.status === "completed", JSON.stringify(out));
  check("session-less create wrote its contacts", out.created === 20, JSON.stringify(out));

  // --- merge path: covers updateContactForUser, the second call site the fix changed ---
  // Re-importing the same rows resolves every one to an existing contact, so this run takes
  // the update branch exclusively. Without it the second fixed line is never executed.
  id = await seedJob(fixture(20));
  await runJob(id);
  out = await outcome(id);
  check("session-less merge does not fail", out.status !== "failed", JSON.stringify(out));
  check(
    "session-less merge records no auth error",
    !AUTH_ERROR.test(out.error ?? ""),
    JSON.stringify(out)
  );
  check("session-less merge completes", out.status === "completed", JSON.stringify(out));
  check("session-less merge took the update branch", out.updated === 20, JSON.stringify(out));

  await reset();
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  console.log("\nResumption auth regression checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
