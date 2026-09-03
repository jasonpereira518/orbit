import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { imports } from "@/db/schema";
import { failImport } from "@/lib/import-engine";
import { RESUMABLE_IMPORT_TYPES, runImportJobById } from "@/lib/import-job-dispatch";

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

export type StallSweepResult = {
  found: number;
  resumed: number;
  resumeFailed: number;
  gaveUp: number;
};

export async function resumeStalledImports(options: {
  now?: Date;
  thresholdMs?: number;
  maxResumes?: number;
  /** Injectable for the smoke test; the real one dispatches by import type. */
  runner?: (importId: string) => Promise<unknown>;
} = {}): Promise<StallSweepResult> {
  const now = options.now ?? new Date();
  const threshold = options.thresholdMs ?? CRON_STALL_THRESHOLD_MS;
  const maxResumes = options.maxResumes ?? MAX_STALL_RESUMES;
  const runner = options.runner ?? runImportJobById;
  const db = await getDb();

  const stalled = await db.query.imports.findMany({
    where: and(
      // Every server-owned job kind, not just LinkedIn — a stalled Gmail recruiter scan
      // needs the same backstop, and it is the longer-running of the two.
      inArray(imports.importType, [...RESUMABLE_IMPORT_TYPES]),
      eq(imports.status, "processing"),
      lt(imports.updatedAt, new Date(now.getTime() - threshold))
    ),
    columns: { id: true },
  });

  const result: StallSweepResult = { found: stalled.length, resumed: 0, resumeFailed: 0, gaveUp: 0 };

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
          `Import stalled ${maxResumes} times and gave up. Please re-upload the file to try again.`
        )
      );
      result.gaveUp += 1;
      continue;
    }
    // One bad import must not stop the others — but the swallow becomes a number rather
    // than disappearing.
    try {
      await runner(job.id);
      result.resumed += 1;
    } catch {
      result.resumeFailed += 1;
    }
  }

  return result;
}
