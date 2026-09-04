import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { cronRuns } from "@/db/schema";
import { toUserFacingError } from "@/lib/errors";

/**
 * The scheduled-job ledger.
 *
 * Deliberately imports nothing from `next/server`: this module is reached from a route
 * handler today, but the same hazard documented in `src/lib/user-settings.ts` applies —
 * that import alone retains the Node event loop and hangs any script that pulls it in.
 * Both writes are awaited for the same reason (a bare un-awaited promise does it too),
 * and because the finish write must land before the lambda freezes.
 */

/** `ops.sweep` is the ten-minute known-condition sweep (`src/lib/ops-sweep.ts`). */
export type CronJobName = "imports.process-stalled" | "ops.sweep" | "sync.run";

export type CronRunStatus = "ok" | "partial" | "failed";

/** `id` is null when the ledger insert itself failed — every consumer must tolerate that. */
export type CronRunHandle = { id: string | null; startedAt: number };

/**
 * A run killed at `maxDuration` never writes a finish row, so it stays `running` forever.
 * Rather than add a second cron to sweep the first, that is resolved on read: any run
 * still `running` well past the 300s function ceiling is reported as `stale`.
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

/** A daily cron that has not started in over a day has missed at least one run. */
const MISSED_AFTER_MS = 25 * 60 * 60 * 1000;

export type CronRunState = "running" | "stale" | "ok" | "partial" | "failed";

export function deriveCronRunState(
  row: { status: string; startedAt: Date; finishedAt: Date | null },
  now = new Date()
): CronRunState {
  if (row.status !== "running") return row.status as CronRunState;
  return now.getTime() - row.startedAt.getTime() > STALE_AFTER_MS
    ? "stale"
    : "running";
}

/** Whether a daily job has gone long enough without starting to have skipped one. */
export function hasMissedRun(
  lastStartedAt: Date | null | undefined,
  now = new Date()
): boolean {
  if (!lastStartedAt) return true;
  return now.getTime() - lastStartedAt.getTime() > MISSED_AFTER_MS;
}

/**
 * Opens a run row before the work begins.
 *
 * Writing at start rather than only at the end is the point of this table. With an
 * end-only write, "the cron never fired" and "the cron fired and died" are the same
 * observation — no row — and they call for completely different responses.
 */
export async function startCronRun(
  job: CronJobName,
  trigger: "schedule" | "manual" = "schedule"
): Promise<CronRunHandle> {
  const startedAt = Date.now();
  try {
    const db = await getDb();
    const [row] = await db
      .insert(cronRuns)
      .values({ job, trigger, status: "running", startedAt: new Date(startedAt) })
      .returning();
    return { id: row?.id ?? null, startedAt };
  } catch {
    // Degrade to today's behaviour (no record) rather than breaking the job this
    // route exists to run.
    return { id: null, startedAt };
  }
}

export async function finishCronRun(
  handle: CronRunHandle,
  outcome: {
    status: CronRunStatus;
    stats?: Record<string, number | boolean>;
    error?: unknown;
  }
): Promise<void> {
  if (!handle.id) return;
  try {
    const db = await getDb();
    await db
      .update(cronRuns)
      .set({
        status: outcome.status,
        finishedAt: new Date(),
        durationMs: Date.now() - handle.startedAt,
        stats: outcome.stats ?? {},
        error: outcome.error
          ? toUserFacingError(outcome.error, "Job failed").message.slice(0, 500)
          : null,
      })
      .where(eq(cronRuns.id, handle.id));
  } catch {
    // The ledger must never fail the job.
  }
}
