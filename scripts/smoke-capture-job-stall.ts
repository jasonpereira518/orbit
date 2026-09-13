/**
 * The capture-job stall backstop gives up after a bounded number of resumes and sweeps
 * old terminal rows — a copy of `smoke-import-stall.ts` for `resumeStalledCaptureJobs`.
 *
 * Run: npx tsx scripts/smoke-capture-job-stall.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { captureJobs } from "../src/db/schema";
import { CAPTURE_JOB_RETENTION_DAYS, MAX_CAPTURE_STALL_RESUMES, resumeStalledCaptureJobs } from "../src/lib/capture-jobs";

const USER = "smoke-capture-stall-user";
const MIN = 60_000;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function seed(over: Partial<typeof captureJobs.$inferInsert>) {
  const db = await getDb();
  const [row] = await db
    .insert(captureJobs)
    .values({ userId: USER, sourceKind: "messy", status: "extracting", inputText: "notes", updatedAt: new Date(Date.now() - 10 * MIN), ...over })
    .returning();
  return row!.id;
}

async function main() {
  const db = await getDb();
  await db.delete(captureJobs).where(eq(captureJobs.userId, USER));

  const fresh = await seed({});
  const queuedOld = await seed({ status: "queued" });
  const exhausted = await seed({ stallResumes: MAX_CAPTURE_STALL_RESUMES });
  const active = await seed({ updatedAt: new Date() });
  const reviewing = await seed({ status: "reviewing" });
  const broken = await seed({ inputText: "broken" });
  const ancient = await seed({ status: "saved", updatedAt: new Date(Date.now() - (CAPTURE_JOB_RETENTION_DAYS + 1) * 86_400_000) });
  const recentSaved = await seed({ status: "saved", updatedAt: new Date() });

  const ran: string[] = [];
  const result = await resumeStalledCaptureJobs({
    now: new Date(),
    runner: async (id) => {
      ran.push(id);
      if (id === broken) throw new Error("runner exploded");
    },
  });

  check("finds the stale in-flight jobs only", result.found === 4 && !ran.includes(active) && !ran.includes(reviewing), JSON.stringify(result));
  check("resumes the ones with resumes to spare", ran.includes(fresh) && ran.includes(queuedOld));
  check("does not run the exhausted one", !ran.includes(exhausted));
  check("counts: 2 resumed, 1 failed to resume, 1 gave up", result.resumed === 2 && result.resumeFailed === 1 && result.gaveUp === 1, JSON.stringify(result));

  const rows = new Map((await db.query.captureJobs.findMany({ where: eq(captureJobs.userId, USER) })).map((r) => [r.id, r]));
  check("the resumed job's counter advanced", rows.get(fresh)?.stallResumes === 1);
  check("the exhausted job is failed with a message that says so", rows.get(exhausted)?.status === "failed" && /gave up/i.test(rows.get(exhausted)?.error ?? ""));
  check("a runner failure leaves the job for next time", rows.get(broken)?.status === "extracting");
  check("the active and reviewing jobs are untouched", rows.get(active)?.stallResumes === 0 && rows.get(reviewing)?.stallResumes === 0);
  check("old terminal rows are swept", result.swept === 1 && !rows.has(ancient), `swept=${result.swept}`);
  check("recent terminal rows are kept", rows.has(recentSaved));

  await db.delete(captureJobs).where(eq(captureJobs.userId, USER));
  console.log("\nsmoke-capture-job-stall: all checks passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
