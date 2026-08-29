import { and, count, inArray, isNotNull, lt, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { contacts, errorEvents, imports, usageEvents } from "@/db/schema";
import {
  RESUMABLE_IMPORT_TYPES,
  runImportJobById,
} from "@/lib/import-job-dispatch";
import {
  finishCronRun,
  startCronRun,
  type CronRunStatus,
} from "@/lib/cron-runs";
import { recalibrateCloseness } from "@/lib/closeness-cohort";
import { findStaleCohorts } from "@/lib/closeness-materialize";
import { kickEmbeddingBackfill, runEmbeddingBackfill } from "@/lib/embedding-backfill";
import {
  kickLinkedInTimelineBackfill,
  usersWithPendingTimelineEvents,
} from "@/lib/linkedin-timeline-backfill";
import { backfillEmbeddingVectors, neonClient } from "@/db";

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

/** Networks recalibrated per run. Bounded so one huge orbit cannot eat the invocation. */
const RECALIBRATE_BATCH = 25;

/** Users listed per run for the embedding backstop — see the try block below. */
const EMBED_BACKFILL_USERS = 25;

/**
 * Users handed to the LinkedIn timeline backfill per run.
 *
 * Kicked, never run inline — unlike the embedding sweep below, which does drain work here
 * under a wall-clock budget. Timeline derivation costs one AI completion per contact, so
 * even a single user's backlog can exceed this route's whole 300s, and this route has a
 * job-resumption backstop to get to. The route it kicks is self-continuing and has its own
 * 300s per invocation, which is where that work belongs.
 */
const TIMELINE_BACKFILL_USERS = 25;

/**
 * Wall-clock ceiling on the whole embedding sweep, and on any single user inside it.
 *
 * This used to be bounded by *user count* alone (10 users, each free to take
 * `runEmbeddingBackfill`'s own 4.5-minute internal budget) inside a route whose
 * `maxDuration` is 300s. One user with a large backlog therefore consumed the entire
 * invocation and two exceeded the ceiling outright — at which point the function is killed,
 * the `finally` never runs, `finishCronRun` never records anything, and the `cron_run` row
 * is stuck `running` forever while the other users are never reached at all. A 5,000-contact
 * import, the stated target scale, is exactly that case.
 *
 * A count cannot bound unbounded per-item work, so the budget is time. Users still pending
 * when it runs out are not dropped: they get a kick to the backfill route, which is
 * self-continuing and has its own 300s to work in (see `kickEmbeddingBackfill`).
 */
const EMBED_SWEEP_BUDGET_MS = 90 * 1000;

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
    cohortsRecalibrated: 0,
    embeddingsBackfilled: 0,
    embeddingsGenerated: 0,
    /** Users handed to the self-continuing backfill route because this run could not
     *  finish them inside `EMBED_SWEEP_BUDGET_MS`. */
    embeddingBackfillsKicked: 0,
    /** Users handed to the self-continuing LinkedIn timeline-event backfill route. */
    timelineBackfillsKicked: 0,
  };

  try {
    const db = await getDb();
    const staleBefore = new Date(Date.now() - CRON_STALL_THRESHOLD_MS);
    const stalled = await db.query.imports.findMany({
      where: and(
        // Every server-owned job kind, not just LinkedIn — a stalled Gmail recruiter
        // scan needs the same backstop, and it is the longer-running of the two.
        inArray(imports.importType, [...RESUMABLE_IMPORT_TYPES]),
        eq(imports.status, "processing"),
        lt(imports.updatedAt, staleBefore)
      ),
    });
    stats.stalledFound = stalled.length;

    for (const job of stalled) {
      // One bad import must not stop the others — but the swallow becomes a number
      // rather than disappearing.
      try {
        await runImportJobById(job.id);
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

    try {
      // Redraw closeness for users whose ranking has been drifting.
      //
      // Ordinary edits score their own contact immediately and flag the distribution
      // dirty; nothing else redraws it, because doing that on read would hand back the
      // full-network scan that materializing closeness exists to remove. This is what
      // eventually settles it. Bounded per run so one enormous orbit cannot use up the
      // whole invocation.
      for (const staleUserId of await findStaleCohorts(RECALIBRATE_BATCH)) {
        await recalibrateCloseness(staleUserId).catch(() => null);
        stats.cohortsRecalibrated += 1;
      }
    } catch {
      status = "partial";
    }

    try {
      // Copy JSONB embeddings into the pgvector column. This used to run on every cold
      // start, where it could spend up to 500 sequential round trips before the first
      // request was served. Nothing needs it to be immediate — an uncopied row just misses
      // vector search until it is picked up here.
      const neonSql = neonClient();
      if (neonSql) stats.embeddingsBackfilled = await backfillEmbeddingVectors(neonSql);
    } catch {
      status = "partial";
    }

    try {
      // Backstop only — imports kick the backfill directly on completion. This catches
      // users whose kick was lost along with the invocation that sent it.
      const staleUsers = await db
        .selectDistinct({ userId: contacts.userId })
        .from(contacts)
        .where(isNotNull(contacts.embeddingStaleAt))
        .limit(EMBED_BACKFILL_USERS);

      const sweepDeadline = Date.now() + EMBED_SWEEP_BUDGET_MS;
      for (const { userId: staleUser } of staleUsers) {
        const left = sweepDeadline - Date.now();
        if (left <= 0) {
          // Out of sweep budget. Hand this user to the self-continuing route rather than
          // dropping them until tomorrow's run — the point of the wall-clock bound is that
          // one backlog cannot starve the others, not that the others go unserved.
          stats.embeddingBackfillsKicked += 1;
          await kickEmbeddingBackfill(staleUser);
          continue;
        }
        // The per-user slice is whatever is left of the sweep, so the sum across users
        // cannot exceed the budget no matter how the backlog is distributed.
        const res = await runEmbeddingBackfill(staleUser, undefined, left).catch(() => null);
        stats.embeddingsGenerated += res?.embedded ?? 0;
        if ((res?.remaining ?? 0) > 0) {
          stats.embeddingBackfillsKicked += 1;
          await kickEmbeddingBackfill(staleUser);
        }
      }
    } catch {
      status = "partial";
    }

    try {
      // Backstop only — the LinkedIn messages adapter's `finalize` kicks this directly when
      // an import completes. This catches users whose kick was lost along with the
      // invocation that sent it, and users whose backlog outlived the kick chain.
      for (const pendingUser of await usersWithPendingTimelineEvents(
        TIMELINE_BACKFILL_USERS
      )) {
        await kickLinkedInTimelineBackfill(pendingUser);
        stats.timelineBackfillsKicked += 1;
      }
    } catch {
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
