/**
 * The leased job queue (spec §5.5, §6.6). Claims are one UPDATE … RETURNING whose WHERE is
 * re-checked under READ COMMITTED; every completion write is fenced on lease_owner so a worker
 * that lost its lease cannot overwrite the one that took over. Also: idempotent enqueue, the
 * attempt ceiling, the gate pausing (not failing) jobs, and the internal route's auth.
 *
 * Run: npx tsx scripts/smoke-outreach-jobs.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import { outreachJobs } from "../src/db/schema";
import {
  claimJobs,
  completeJob,
  enqueueJob,
  failExhaustedJobs,
  resumePausedJobs,
} from "../src/lib/outreach/jobs/queue";
import { runWorkerPass, type JobHandlers } from "../src/lib/outreach/jobs/worker";
import { POST as workerRoute } from "../src/app/api/outreach/worker/route";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "smoke-jobs-user";

async function statusOf(id: string) {
  const db = await getDb();
  const [row] = await db.select().from(outreachJobs).where(eq(outreachJobs.id, id));
  return row;
}

async function main() {
  const db = await getDb();
  let clock = new Date("2026-09-13T12:00:00Z");
  const now = () => clock;
  const sleep = async (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  console.log("Enqueue and claim...");
  const a = await enqueueJob({ userId: USER, kind: "ranking.batch", idempotencyKey: "k-a", runAfter: clock });
  const again = await enqueueJob({ userId: USER, kind: "ranking.batch", idempotencyKey: "k-a", runAfter: clock });
  check("a repeated key returns the same job", again.id === a.id && a.created && !again.created);
  const future = await enqueueJob({ userId: USER, kind: "ranking.batch", runAfter: new Date(clock.getTime() + 60_000) });

  const first = await claimJobs("w1", 10, clock, 90_000);
  check("only due jobs are claimed", first.length === 1 && first[0].id === a.id);
  check("a held lease is not claimable", (await claimJobs("w2", 10, clock, 90_000)).length === 0);

  clock = new Date(clock.getTime() + 91_000);
  const stolen = await claimJobs("w2", 10, clock, 90_000);
  check("an expired lease is reclaimable (and the future job is now due)", stolen.length === 2, JSON.stringify(stolen.map((s) => s.id)));
  check("reclaiming an abandoned job counts an attempt", stolen.find((j) => j.id === a.id)?.attempts === 1);
  check("the stale worker cannot complete it", !(await completeJob(a.id, "w1", {}, clock)));
  check("the current holder can", await completeJob(a.id, "w2", { ok: true }, clock));
  await completeJob(future.id, "w2", {}, clock);

  console.log("Attempt ceiling...");
  const fragile = await enqueueJob({ userId: USER, kind: "ranking.batch", maxAttempts: 2, runAfter: clock });
  await claimJobs("w3", 10, clock, 1_000);
  clock = new Date(clock.getTime() + 2_000);
  await claimJobs("w4", 10, clock, 1_000);
  clock = new Date(clock.getTime() + 2_000);
  check("a job abandoned past its ceiling is not claimed again", (await claimJobs("w5", 10, clock, 1_000)).length === 0);
  check("…and is failed by the exhaustion sweep", (await failExhaustedJobs(clock)) === 1 && (await statusOf(fragile.id)).status === "failed");

  console.log("Worker outcomes...");
  await db.delete(outreachJobs);
  const calls: string[] = [];
  let continues = 0;
  const handlers: JobHandlers = {
    "ranking.batch": async ({ job }) => {
      calls.push(`rank:${String(job.payload.n)}`);
      return { status: "succeeded", result: { n: job.payload.n } };
    },
    "ranking.rerank": async () => {
      continues++;
      return continues < 3 ? { status: "continue", runAfterMs: 2_000 } : { status: "succeeded" };
    },
    "research.person": async () => {
      throw new Error("provider exploded");
    },
    "discovery.run": async () => ({ status: "failed", error: "Confirm the audience first" }),
  };
  const ok = await enqueueJob({ userId: USER, kind: "ranking.batch", payload: { n: 1 }, runAfter: clock });
  const looping = await enqueueJob({ userId: USER, kind: "ranking.rerank", runAfter: clock });
  const throwing = await enqueueJob({ userId: USER, kind: "research.person", maxAttempts: 2, runAfter: clock });
  const failing = await enqueueJob({ userId: USER, kind: "discovery.run", runAfter: clock });
  const unknown = await enqueueJob({ userId: USER, kind: "mail.sync", runAfter: clock });
  const open = async () => true;

  const stats = await runWorkerPass({ handlers, now, sleep, gate: open, workerId: "wp" });
  check("a succeeded job is done", (await statusOf(ok.id)).status === "succeeded" && calls.includes("rank:1"));
  check("continue re-queues and the pass keeps going until done", (await statusOf(looping.id)).status === "succeeded" && continues === 3);
  check("continue does not count as an attempt", (await statusOf(looping.id)).attempts === 0);
  const thrown = await statusOf(throwing.id);
  check("a throwing handler is retried with backoff", thrown.status === "queued" && thrown.attempts === 1 && thrown.runAfter > clock, JSON.stringify(thrown));
  check("a failed outcome is terminal with its message", (await statusOf(failing.id)).status === "failed" && (await statusOf(failing.id)).lastError === "Confirm the audience first");
  check("a kind with no handler fails", (await statusOf(unknown.id)).status === "failed");
  check("stats add up", stats.succeeded === 2 && stats.failed === 2 && stats.retried === 1 && stats.continued === 2, JSON.stringify(stats));

  clock = new Date(clock.getTime() + 60 * 60_000);
  await runWorkerPass({ handlers, now, sleep, gate: open, workerId: "wp2" });
  check("the retry ceiling turns the second throw into a failure", (await statusOf(throwing.id)).status === "failed");

  console.log("The gate pauses rather than fails...");
  const gated = await enqueueJob({ userId: USER, kind: "ranking.batch", payload: { n: 2 }, runAfter: clock });
  await runWorkerPass({ handlers, now, sleep, gate: async () => false, workerId: "wg" });
  check("a closed gate pauses the job", (await statusOf(gated.id)).status === "paused");
  check("resume re-queues paused jobs", (await resumePausedJobs(USER, clock)) === 1 && (await statusOf(gated.id)).status === "queued");

  console.log("The internal route...");
  const priorSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "smoke-secret";
  try {
    const denied = await workerRoute(new Request("http://orbit.test/api/outreach/worker", { method: "POST" }));
    check("the worker route refuses an unauthenticated call", denied.status === 401);
  } finally {
    if (priorSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = priorSecret;
  }

  console.log("All outreach job checks passed.");
}

run(main);
