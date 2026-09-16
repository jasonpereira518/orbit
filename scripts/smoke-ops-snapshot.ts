/**
 * Asserts `loadOpsSnapshot` reads each ops condition's source rows from a real database,
 * and that the catalogue turns them into the right condition. The pure predicates live in
 * smoke-ops-alerts; this pins the queries behind them.
 *
 * Run: npx tsx scripts/smoke-ops-snapshot.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
// Off production, so the production-only fields stay quiet unless a section sets it.
delete process.env.VERCEL_ENV;

import { inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { cronRuns } from "../src/db/schema";
import { evaluateOpsConditions } from "../src/lib/ops-alerts";
import { loadOpsSnapshot } from "../src/lib/ops-sweep";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const JOBS = ["imports.process-stalled", "webhooks.drain", "sync.run"] as const;

async function cronRun(job: (typeof JOBS)[number], status: "ok" | "partial" | "failed", minutesAgo: number) {
  const db = await getDb();
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await db.insert(cronRuns).values({ job, trigger: "manual", status, startedAt: at, finishedAt: at });
}

async function idsNow(): Promise<string[]> {
  const now = new Date();
  return evaluateOpsConditions(await loadOpsSnapshot(now, null), now).map((c) => c.id);
}

run(async () => {
  const db = await getDb();
  await db.delete(cronRuns).where(inArray(cronRuns.job, [...JOBS]));

  console.log("Cron ledger...");
  await cronRun("imports.process-stalled", "partial", 180);
  await cronRun("imports.process-stalled", "partial", 120);
  await cronRun("imports.process-stalled", "partial", 60);
  await cronRun("webhooks.drain", "failed", 5);
  const snap = await loadOpsSnapshot(new Date(), null);
  check("the last three process-stalled states are read, newest first",
    JSON.stringify(snap.processStalledRecent) === JSON.stringify(["partial", "partial", "partial"]),
    JSON.stringify(snap.processStalledRecent));
  check("the drain's last state is read", snap.cron.drain.lastState === "failed", JSON.stringify(snap.cron.drain));
  let ids = await idsNow();
  check("three partial runs open cron.partial_streak", ids.includes("cron.partial_streak"), ids.join(","));
  check("a failed drain opens drain.failed", ids.includes("drain.failed"), ids.join(","));

  await cronRun("imports.process-stalled", "ok", 1);
  await cronRun("webhooks.drain", "partial", 1);
  ids = await idsNow();
  check("an ok run breaks the streak", !ids.includes("cron.partial_streak"), ids.join(","));
  check("a partial drain is not drain.failed", !ids.includes("drain.failed"), ids.join(","));
  await db.delete(cronRuns).where(inArray(cronRuns.job, [...JOBS]));

  // (new sections go above this line)

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll ops-snapshot checks passed.");
});
