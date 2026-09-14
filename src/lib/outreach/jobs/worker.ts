import { randomUUID } from "node:crypto";
import type { OutreachJobKind } from "@/db/schema";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { WORKER } from "@/lib/outreach/config";
import { isOutreachNextEnabled } from "@/lib/outreach/gate";
import {
  claimJobs,
  completeJob,
  continueJob,
  extendLease,
  failExhaustedJobs,
  failJob,
  listUsersWithPausedJobs,
  msUntilNextDue,
  pauseJob,
  resumePausedJobs,
  retryJob,
  type JobRow,
} from "@/lib/outreach/jobs/queue";

export type JobContext = {
  job: JobRow;
  workerId: string;
  now: () => Date;
  /** Epoch ms. Handlers yield with `continue` before this rather than overrun it. */
  deadline: number;
  extendLease: () => Promise<boolean>;
};

export type JobOutcome =
  | { status: "succeeded"; result?: Record<string, unknown> }
  | { status: "continue"; runAfterMs?: number; progress?: Record<string, unknown> }
  | { status: "retry"; error: string; backoffMs?: number }
  | { status: "failed"; error: string };

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome>;
export type JobHandlers = Partial<Record<OutreachJobKind, JobHandler>>;

export type WorkerStats = {
  claimed: number;
  succeeded: number;
  continued: number;
  retried: number;
  failed: number;
  paused: number;
  /** Jobs re-queued at the start of the pass because their user is back inside the gate. */
  resumed: number;
  moreDue: boolean;
};

/** Short waits (a discovery run polling its ranking jobs) are slept through in one pass. */
const MAX_IDLE_WAIT_MS = 15_000;
/** How many users with paused jobs one pass re-checks against the gate. */
const RESUME_USERS_PER_PASS = 50;

export function backoffFor(attempts: number) {
  return Math.min(30_000 * 2 ** attempts, 15 * 60_000);
}

export async function runWorkerPass(
  opts: {
    handlers?: JobHandlers;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
    budgetMs?: number;
    workerId?: string;
    claimBatch?: number;
    gate?: (userId: string) => Promise<boolean>;
  } = {}
): Promise<WorkerStats> {
  const handlers = opts.handlers ?? {};
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const gate = opts.gate ?? isOutreachNextEnabled;
  const workerId = opts.workerId ?? `worker:${randomUUID()}`;
  const passDeadline = Date.now() + (opts.budgetMs ?? WORKER.passBudgetMs);
  const stats: WorkerStats = { claimed: 0, succeeded: 0, continued: 0, retried: 0, failed: 0, paused: 0, resumed: 0, moreDue: false };

  /**
   * The other half of pausing (spec §4.1): a paused job resumes on the first pass after its
   * user is back inside the gate — turning OUTREACH_NEXT off and on again, or an admin who
   * stops viewing as a user. Nothing else ever resumes one.
   *
   * A paused discovery run keeps its credit hold for the whole pause, deliberately: it resumes
   * exactly where it left off, and its research still needs those credits. That is also why
   * `countOutstandingJobs` counts 'paused' and the run reaper leaves such a run alone.
   *
   * Per user, and never fatal to the pass: one gate lookup that throws skips that user until
   * the next pass rather than stopping everyone else's work.
   */
  async function resumeUsersBackInsideGate() {
    let users: string[];
    try {
      users = await listUsersWithPausedJobs(RESUME_USERS_PER_PASS);
    } catch (err) {
      await recordErrorEvent({
        source: ERROR_SOURCES.outreachWorker,
        kind: "resume",
        message: err instanceof Error ? err.message : String(err),
        context: { stage: "list-paused" },
      });
      return;
    }
    for (const userId of users) {
      try {
        if (await gate(userId)) stats.resumed += await resumePausedJobs(userId, now());
      } catch (err) {
        await recordErrorEvent({
          source: ERROR_SOURCES.outreachWorker,
          kind: "resume",
          userId,
          message: err instanceof Error ? err.message : String(err),
          context: { stage: "resume" },
        });
      }
    }
  }

  /**
   * One job, never throwing. A handler's own throw is already an outcome (retry, below); what
   * this wrapper catches is a failure to RECORD an outcome — the fenced write itself erroring
   * (a database hiccup, a value Postgres refuses). Letting that escape rejected the whole
   * batch and ended the pass, abandoning every other job in it. Instead it is recorded and
   * the job is left exactly as it stands: still `running` under this worker's lease, so the
   * next claim after the lease expires picks it up like any abandoned job.
   */
  async function runOne(job: JobRow) {
    try {
      await runOneUnguarded(job);
    } catch (err) {
      await recordErrorEvent({
        source: ERROR_SOURCES.outreachWorker,
        kind: job.kind,
        userId: job.userId,
        message: err instanceof Error ? err.message : String(err),
        context: { jobId: job.id, attempts: job.attempts, stage: "record-outcome" },
      });
    }
  }

  async function runOneUnguarded(job: JobRow) {
    if (!(await gate(job.userId))) {
      await pauseJob(job.id, workerId, now());
      stats.paused++;
      return;
    }
    const handler = handlers[job.kind];
    if (!handler) {
      await failJob(job.id, workerId, `No handler for ${job.kind}`, now());
      stats.failed++;
      return;
    }
    let outcome: JobOutcome;
    try {
      outcome = await handler({
        job,
        workerId,
        now,
        deadline: Math.min(Date.now() + WORKER.jobBudgetMs, passDeadline),
        extendLease: () => extendLease(job.id, workerId, WORKER.leaseMs, now()),
      });
    } catch (err) {
      await recordErrorEvent({
        source: ERROR_SOURCES.outreachWorker,
        kind: job.kind,
        userId: job.userId,
        message: err instanceof Error ? err.message : String(err),
        context: { jobId: job.id, attempts: job.attempts },
      });
      outcome = { status: "retry", error: "The job stopped unexpectedly", backoffMs: backoffFor(job.attempts) };
    }
    const at = now();
    switch (outcome.status) {
      case "succeeded":
        if (await completeJob(job.id, workerId, outcome.result ?? {}, at)) stats.succeeded++;
        break;
      case "continue":
        if (await continueJob(job.id, workerId, { runAfter: new Date(at.getTime() + (outcome.runAfterMs ?? 0)), progress: outcome.progress }, at)) {
          stats.continued++;
        }
        break;
      case "retry": {
        const status = await retryJob(job.id, workerId, outcome.error, outcome.backoffMs ?? backoffFor(job.attempts), at);
        if (status === "failed") stats.failed++;
        else if (status === "queued") stats.retried++;
        break;
      }
      case "failed":
        if (await failJob(job.id, workerId, outcome.error, at)) stats.failed++;
        break;
    }
  }

  await resumeUsersBackInsideGate();

  while (Date.now() < passDeadline - 5_000) {
    await failExhaustedJobs(now());
    const jobs = await claimJobs(workerId, opts.claimBatch ?? WORKER.claimBatch, now(), WORKER.leaseMs);
    if (jobs.length === 0) {
      const wait = await msUntilNextDue(now());
      if (wait === null || wait > MAX_IDLE_WAIT_MS || Date.now() + wait > passDeadline - 5_000) break;
      await sleep(Math.max(wait, 250));
      continue;
    }
    stats.claimed += jobs.length;
    // `runOne` never rejects; allSettled is the belt to its braces, so one job can never end
    // the pass for the rest of its batch.
    await Promise.allSettled(jobs.map(runOne));
  }

  const next = await msUntilNextDue(now());
  stats.moreDue = next !== null && next <= 60_000;
  return stats;
}
