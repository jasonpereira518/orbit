/**
 * One runner per import (`runImportJobById` in src/lib/import-job-dispatch.ts, v113).
 *
 * The row claim alone let two runners work one import at once: a continuation and a manual
 * retry, or a slow continuation and the stall backstop's kick. Each claimed rows the other
 * was mid-way through, and a row with no email or LinkedIn URL (nothing for the duplicate
 * index to catch) was imported twice. The job-level lease makes the second runner wait for
 * the first and then find the work done.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-import-lease.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-import-lease";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-import-lease";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, imports } from "../src/db/schema";
import { acquireImportLease, releaseImportLease, runImportJobById } from "../src/lib/import-job-dispatch";
import { stageImportRows } from "../src/lib/import-job-rows";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-import-lease-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function run(importId: string) {
  try {
    await runImportJobById(importId);
  } catch (err) {
    // The one error a bare script produces: revalidatePath outside a Next request. The job
    // row is already final by then (see smoke-import-engine's runJob).
    if (!String(err instanceof Error ? err.message : err).startsWith("Invariant: static generation store missing")) throw err;
  }
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await ensureUserSettings(USER);

  console.log("the lease");
  const [job] = await db.insert(imports).values({ userId: USER, importType: "linkedin_connections", status: "processing", totalRows: 0, stats: {} }).returning();
  check("a free job can be taken", await acquireImportLease(job!.id, "runner-a", 0));
  check("a held job cannot", !(await acquireImportLease(job!.id, "runner-b", 0)));
  await releaseImportLease(job!.id, "runner-b");
  check("only its holder can release it", !(await acquireImportLease(job!.id, "runner-b", 0)));
  await releaseImportLease(job!.id, "runner-a");
  check("once released, it can be taken", await acquireImportLease(job!.id, "runner-b", 0));
  await db.execute(sql`UPDATE imports SET runner_lease_until = now() - interval '1 second' WHERE id = ${job!.id}`);
  check("a lease that ran out (a runner that died) does not hold the job", await acquireImportLease(job!.id, "runner-c", 0));
  const waited = acquireImportLease(job!.id, "runner-d", 5_000);
  setTimeout(() => void releaseImportLease(job!.id, "runner-c"), 800);
  check("a successor waits for its predecessor to let go", await waited);

  console.log("two runners, one import");
  const N = 120;
  const [race] = await db.insert(imports).values({ userId: USER, importType: "linkedin_connections", fileName: "race.csv", status: "processing", totalRows: N, stats: {} }).returning();
  // Name-only rows: nothing for the duplicate index to match on, so a row claimed twice
  // would be a second contact.
  await stageImportRows(
    Array.from({ length: N }, (_, i) => ({
      importId: race!.id,
      userId: USER,
      rowIndex: i,
      payload: { index: i, firstName: `Racer${i}`, lastName: "Nameonly", email: "", company: "", position: "", connectedOn: "", url: "" } as never,
    }))
  );
  await Promise.all([run(race!.id), run(race!.id), run(race!.id)]);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(eq(contacts.userId, USER))) as [{ n: number }];
  check("every row imported exactly once", n === N, `${n} contacts for ${N} rows`);
  const done = await db.query.imports.findFirst({ where: eq(imports.id, race!.id) });
  check("the job finished, and let go of its lease", done?.status === "completed" && done.runnerToken === null, JSON.stringify({ status: done?.status, token: done?.runnerToken }));

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll import lease checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
