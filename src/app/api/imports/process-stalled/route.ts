import { and, count, eq, lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { errorEvents, imports, usageEvents } from "@/db/schema";
import { runLinkedInImportJob } from "@/lib/import-job-processor";
import {
  finishCronRun,
  startCronRun,
  type CronRunStatus,
} from "@/lib/cron-runs";

export const maxDuration = 300;

/**
 * How long a server-owned import must be untouched before this backstop resumes it.
 *
 * Deliberately different from `WEDGED_IMPORT_MS` in `src/lib/admin-ops.ts` (10 min). The
 * two thresholds are not a discrepancy to reconcile — they mark the two ownership classes.
 * This one means "the cron will pick this up"; that one means "nothing ever will."
 */
export const CRON_STALL_THRESHOLD_MS = 3 * 60 * 1000;

/**
 * `usage_events` is write-only and nothing user-facing reads it, so without a sweep it
 * quietly becomes the largest table in the database. Six months is well past the window
 * any admin view looks at.
 */
const USAGE_EVENT_RETENTION_DAYS = 180;

/**
 * Shorter than usage events, because the two answer different questions: usage feeds cost
 * and adoption rollups that look backwards, while this one answers "what is broken now".
 */
const ERROR_EVENT_RETENTION_DAYS = 30;

async function pruneOlderThan(
  table: typeof usageEvents | typeof errorEvents,
  days: number
): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // Count first rather than trusting a driver-specific `rowCount` — neon-http and pglite
  // disagree about the shape of a delete result. Both tables are indexed on created_at.
  const [row] = await db
    .select({ value: count() })
    .from(table)
    .where(lt(table.createdAt, cutoff));
  await db.delete(table).where(lt(table.createdAt, cutoff));
  return row?.value ?? 0;
}

/**
 * Vercel Cron target: resumes server-owned import jobs whose invocation died
 * mid-run. Runs once/day (Hobby plan's minimum cron interval) — the primary
 * resumption path is still the processor's own self-continuation via the
 * `[id]/continue` route; this is only a last-resort backstop.
 *
 * It is also the only scheduled job in the product, so housekeeping rides along and every
 * run is recorded in `cron_runs`. Note the consequence for anything that depends on this:
 * a job that loses self-continuation can sit stalled for up to 24 hours.
 */
export async function GET(request: Request) {
  // Auth first, before any write: an unauthenticated probe must not be able to
  // insert ledger rows.
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse(null, { status: 401 });
  }

  const run = await startCronRun("imports.process-stalled");

  let status: CronRunStatus = "ok";
  let error: unknown = null;
  const stats = {
    stalledFound: 0,
    resumed: 0,
    resumeFailed: 0,
    usageEventsPruned: 0,
    errorEventsPruned: 0,
  };

  try {
    const db = await getDb();
    const staleBefore = new Date(Date.now() - CRON_STALL_THRESHOLD_MS);
    const stalled = await db.query.imports.findMany({
      where: and(
        eq(imports.importType, "linkedin_connections"),
        eq(imports.status, "processing"),
        lt(imports.updatedAt, staleBefore)
      ),
    });
    stats.stalledFound = stalled.length;

    for (const job of stalled) {
      // One bad import must not stop the others — but the swallow becomes a number
      // rather than disappearing.
      try {
        await runLinkedInImportJob(job.id);
        stats.resumed += 1;
      } catch {
        stats.resumeFailed += 1;
      }
    }

    try {
      stats.usageEventsPruned = await pruneOlderThan(
        usageEvents,
        USAGE_EVENT_RETENTION_DAYS
      );
      stats.errorEventsPruned = await pruneOlderThan(
        errorEvents,
        ERROR_EVENT_RETENTION_DAYS
      );
    } catch {
      // Housekeeping must never fail the job-resumption backstop this route exists for,
      // but a silent failure here is how a table grows unbounded — so it downgrades the
      // run instead of vanishing.
      status = "partial";
    }

    if (stats.resumeFailed > 0) status = "partial";
  } catch (err) {
    status = "failed";
    error = err;
  } finally {
    // In `finally` so it survives an early return and cannot be forgotten in a new branch.
    await finishCronRun(run, { status, stats, error });
  }

  // A 500 turns the failure red in Vercel's own cron log for free. Vercel does not retry
  // failed crons, so there is no retry-storm risk in reporting honestly.
  return NextResponse.json(
    { runId: run.id, status, ...stats },
    { status: status === "failed" ? 500 : 200 }
  );
}
