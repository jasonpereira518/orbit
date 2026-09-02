/**
 * Asserts the stalled-import backstop gives up after a bounded number of resumes.
 *
 * `process-stalled` resumes any server-owned import that has gone quiet. Without a limit,
 * a job that fails deterministically is resumed on every run forever — the user sees
 * "processing" for days, and nothing ever tells them to re-upload. `imports.stall_resumes`
 * counts the backstop's resumes (self-continuations do not count); past
 * `MAX_STALL_RESUMES` the job is marked failed with a message the UI already shows.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-import-stall.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { imports } from "../src/db/schema";
import { MAX_STALL_RESUMES, resumeStalledImports } from "../src/lib/import-stall";

const USER = "smoke-import-stall-user";
const MIN = 60_000;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function seed(over: Partial<typeof imports.$inferInsert>) {
  const db = await getDb();
  const [row] = await db
    .insert(imports)
    .values({
      userId: USER,
      importType: "linkedin_connections",
      status: "processing",
      fileName: "connections.csv",
      updatedAt: new Date(Date.now() - 10 * MIN),
      ...over,
    })
    .returning();
  return row.id;
}

async function main() {
  const db = await getDb();
  await db.delete(imports).where(eq(imports.userId, USER));

  const fresh = await seed({});
  const exhausted = await seed({ stallResumes: MAX_STALL_RESUMES });
  const active = await seed({ updatedAt: new Date() });
  const broken = await seed({ fileName: "broken.csv" });

  const ran: string[] = [];
  const result = await resumeStalledImports({
    now: new Date(),
    runner: async (id) => {
      ran.push(id);
      if (id === broken) throw new Error("runner exploded");
    },
  });

  check("finds the stale jobs and not the active one", result.found === 3 && !ran.includes(active), JSON.stringify(result));
  check("resumes the job with resumes to spare", ran.includes(fresh));
  check("does not run the exhausted job", !ran.includes(exhausted));
  check("counts: 1 resumed, 1 failed to resume, 1 gave up",
    result.resumed === 1 && result.resumeFailed === 1 && result.gaveUp === 1, JSON.stringify(result));

  const byId = new Map((await db.query.imports.findMany({ where: eq(imports.userId, USER) })).map((r) => [r.id, r]));
  check("the resumed job's counter advanced to 1", byId.get(fresh)?.stallResumes === 1);
  check("the exhausted job is failed with a message that says so",
    byId.get(exhausted)?.status === "failed" && /gave up/i.test(byId.get(exhausted)?.errorMessage ?? ""),
    JSON.stringify(byId.get(exhausted)));
  check("a runner failure leaves the job processing for next time", byId.get(broken)?.status === "processing");
  check("the active job is untouched", byId.get(active)?.stallResumes === 0 && byId.get(active)?.status === "processing");

  await db.delete(imports).where(eq(imports.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll import-stall checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
