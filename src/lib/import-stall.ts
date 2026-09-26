import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { imports } from "@/db/schema";
import { failImport } from "@/lib/import-engine";
import { RESUMABLE_IMPORT_TYPES } from "@/lib/import-job-dispatch";
import { internalFetch } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";

/**
 * The stalled-import backstop: resume server-owned jobs that went quiet, a bounded number
 * of times.
 *
 * A job normally continues itself (`scheduleContinuation`); this is what picks it up when
 * that kick was lost. Without a limit, a job that fails deterministically was resumed on
 * every run forever — "processing" for days, and nothing ever told the user to re-upload.
 * `imports.stall_resumes` counts the backstop's resumes (self-continuations do not count);
 * past `MAX_STALL_RESUMES` the job is marked failed through the same path every other
 * failure takes, so the message shows in the existing import history UI.
 *
 * `RESUMABLE_IMPORT_TYPES` stays the single list of what may be resumed at all.
 */

/** How long a server-owned import must be untouched before this backstop resumes it. */
export const CRON_STALL_THRESHOLD_MS = 3 * 60 * 1000;

/** Resumes allowed before giving up. The fourth stall marks the job failed. */
export const MAX_STALL_RESUMES = 3;

/**
 * Stalled jobs picked up per sweep, oldest first. The rest wait for the next sweep. A
 * kick costs one internal request, so this bounds the sweep's time, not the jobs' work.
 */
export const STALL_SWEEP_LIMIT = 50;

/**
 * Resume a job by handing it to its own continuation route, which has a fresh 300s
 * invocation to work in.
 *
 * The backstop used to await the whole job inline. Each resume can take up to the
 * engine's 4.5-minute budget, inside a 300s route that also runs every hourly housekeeping
 * task after it. Two stalled imports in the same hour killed the function: the rest of
 * the housekeeping never ran and the cron_runs row stayed "running". Throws on a non-2xx,
 * so a refused kick counts as a failed resume rather than a silent success.
 */
export async function kickImportContinuation(importId: string): Promise<void> {
  const res = await internalFetch(`/api/imports/${importId}/continue`, { method: "POST" });
  if (!res.ok) throw new Error(`import continuation kick answered ${res.status}`);
}

export type StallSweepResult = {
  found: number;
  resumed: number;
  resumeFailed: number;
  gaveUp: number;
};

export async function resumeStalledImports(
  options: {
    now?: Date;
    thresholdMs?: number;
    maxResumes?: number;
    limit?: number;
    /** Injectable for the smoke test; the real one kicks the job's continuation route. */
    runner?: (importId: string) => Promise<unknown>;
  } = {},
): Promise<StallSweepResult> {
  const now = options.now ?? new Date();
  const threshold = options.thresholdMs ?? CRON_STALL_THRESHOLD_MS;
  const maxResumes = options.maxResumes ?? MAX_STALL_RESUMES;
  const runner = options.runner ?? kickImportContinuation;
  const db = await getDb();

  const stalled = await db.query.imports.findMany({
    where: and(
      // Every server-owned job kind, not just LinkedIn — a stalled Gmail recruiter scan
      // needs the same backstop, and it is the longer-running of the two.
      inArray(imports.importType, [...RESUMABLE_IMPORT_TYPES]),
      eq(imports.status, "processing"),
      lt(imports.updatedAt, new Date(now.getTime() - threshold)),
    ),
    columns: { id: true },
    orderBy: [asc(imports.updatedAt)],
    limit: options.limit ?? STALL_SWEEP_LIMIT,
  });

  const result: StallSweepResult = {
    found: stalled.length,
    resumed: 0,
    resumeFailed: 0,
    gaveUp: 0,
  };

  for (const job of stalled) {
    // Bump-and-read in one statement. `updated_at` is deliberately NOT touched here: if
    // the resume below fails, the job must still look stale to the next sweep.
    const [row] = await db
      .update(imports)
      .set({ stallResumes: sql`${imports.stallResumes} + 1` })
      .where(eq(imports.id, job.id))
      .returning();
    if ((row?.stallResumes ?? 0) > maxResumes) {
      await failImport(
        job.id,
        new Error(
          `Import stalled ${maxResumes} times and gave up — upload the file again to import the rest`,
        ),
      );
      result.gaveUp += 1;
      continue;
    }
    // One bad import must not stop the others — but the swallow becomes a number rather
    // than disappearing.
    try {
      await runner(job.id);
      result.resumed += 1;
    } catch (err) {
      result.resumeFailed += 1;
      reportError(err, {
        where: "job.import.resume-stalled",
        extra: { importId: job.id },
      });
    }
  }

  return result;
}
