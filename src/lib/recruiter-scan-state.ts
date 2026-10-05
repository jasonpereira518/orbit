import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { imports, recruiterScanState } from "@/db/schema";

/**
 * Watermark bookkeeping for the Gmail recruiter scan.
 *
 * Kept apart from the job runner because the two answer different questions: the runner asks
 * "what work is left in this job", this asks "what slice of the mailbox is this job even
 * about". Getting the second one wrong is expensive — an unbounded window re-reads years of
 * mail and re-bills the user's own API key for classifications it already made.
 */

/**
 * Generation of the classifier. Bumping this invalidates every cached sender verdict, which
 * is what makes "re-scan everything" mean something after a prompt change — without it, a
 * smarter classifier would never get a second look at senders the old one rejected.
 */
export const RECRUITER_PROMPT_VERSION = 1;

/** Default reach of a full scan. */
export const DEFAULT_WINDOW_MONTHS = 24;

/**
 * Backdate the incremental watermark by this much. Gmail's `after:` is date-granular and
 * mail can land with an internal date slightly behind its arrival, so resuming exactly at
 * the last scan time would drop messages that appeared underneath the cursor. Re-reading two
 * days of mail is cheap; the verdict cache absorbs almost all of it.
 */
const INCREMENTAL_OVERLAP_DAYS = 2;

export type ScanWindow = {
  /** Lower bound handed to the Gmail query. */
  after: Date;
  /** True when this run ignores the watermark and re-reads the whole window. */
  isFull: boolean;
  promptVersion: number;
  windowMonths: number;
};

function monthsAgo(months: number): Date {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

export async function getScanState(userId: string) {
  const db = await getDb();
  return (
    (await db.query.recruiterScanState.findFirst({
      where: eq(recruiterScanState.userId, userId),
    })) ?? null
  );
}

/**
 * Start time of the newest COMPLETED scan of one import type — the watermark for a mailbox
 * that keeps its own history instead of the shared `recruiter_scan_state` row.
 *
 * `recruiter_scan_state` holds ONE watermark per user, so it cannot serve two mailboxes: a
 * completed Gmail scan would make a user's first Outlook scan look incremental and skip
 * every older message, and a completed Outlook scan would do the same to a later first Gmail
 * scan. A scan job already freezes its own `scanStartedAt` into `imports.stats` and only
 * ever reaches `completed` after finishing its whole window, so the newest completed job of
 * a given type IS that mailbox's watermark — no extra table needed.
 */
export async function lastCompletedScanStart(
  userId: string,
  importType: string
): Promise<Date | null> {
  const db = await getDb();
  const rows = await db
    .select({ stats: imports.stats })
    .from(imports)
    .where(
      and(
        eq(imports.userId, userId),
        eq(imports.importType, importType),
        eq(imports.status, "completed")
      )
    )
    .orderBy(desc(imports.updatedAt))
    .limit(10);
  for (const row of rows) {
    const at = row.stats?.scanStartedAt ? new Date(row.stats.scanStartedAt) : null;
    if (at && !Number.isNaN(at.getTime())) return at;
  }
  return null;
}

/**
 * Decides how far back this run reads.
 *
 * A full scan — first run, an explicit "re-scan everything", or a prompt-version change that
 * stranded the cached verdicts — reaches back `windowMonths`. Everything else resumes from
 * the watermark, which is why a routine re-scan costs a rounding error of the first one.
 *
 * `opts.since` swaps the shared watermark for a caller-supplied one (`null` = this mailbox
 * has never completed a scan, so read the whole window). The Gmail scan omits it and keeps
 * the shared row exactly as before. Prompt-version staleness is not consulted under `since`:
 * that version lives on the shared row, which a caller with its own watermark never writes.
 */
export async function resolveScanWindow(
  userId: string,
  opts: { full?: boolean; since?: Date | null } = {}
): Promise<ScanWindow> {
  const state = await getScanState(userId);
  const windowMonths = state?.windowMonths ?? DEFAULT_WINDOW_MONTHS;
  const floor = monthsAgo(windowMonths);

  const ownWatermark = opts.since !== undefined;
  const lastScanAt = ownWatermark ? opts.since : (state?.lastScanAt ?? null);
  const stale = ownWatermark ? false : (state?.promptVersion ?? 0) !== RECRUITER_PROMPT_VERSION;
  const forced = opts.full === true || !lastScanAt || stale;

  if (forced) {
    return { after: floor, isFull: true, promptVersion: RECRUITER_PROMPT_VERSION, windowMonths };
  }

  // Never resume from before the window floor — shrinking `windowMonths` must not be
  // overridden by an older watermark.
  const resume = daysBefore(lastScanAt, INCREMENTAL_OVERLAP_DAYS);
  return {
    after: resume > floor ? resume : floor,
    isFull: false,
    promptVersion: RECRUITER_PROMPT_VERSION,
    windowMonths,
  };
}

/**
 * Advances the watermark. Call only on a scan that actually reached `completed`.
 *
 * `startedAt` is the job's start, not now: mail that arrived while the scan was running was
 * never in its result set, and stamping the finish time would skip it forever.
 */
export async function markScanCompleted(
  userId: string,
  opts: { startedAt: Date; wasFull: boolean }
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await db
    .insert(recruiterScanState)
    .values({
      userId,
      lastScanAt: opts.startedAt,
      lastFullScanAt: opts.wasFull ? opts.startedAt : null,
      promptVersion: RECRUITER_PROMPT_VERSION,
      windowMonths: DEFAULT_WINDOW_MONTHS,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: recruiterScanState.userId,
      set: {
        lastScanAt: opts.startedAt,
        ...(opts.wasFull ? { lastFullScanAt: opts.startedAt } : {}),
        promptVersion: RECRUITER_PROMPT_VERSION,
        updatedAt: now,
      },
    });
}

/** Persists a user's chosen reach for full scans. */
export async function setScanWindowMonths(
  userId: string,
  windowMonths: number
): Promise<void> {
  const db = await getDb();
  const months = Math.max(1, Math.min(120, Math.round(windowMonths)));
  const now = new Date();
  await db
    .insert(recruiterScanState)
    .values({ userId, windowMonths: months, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: recruiterScanState.userId,
      set: { windowMonths: months, updatedAt: now },
    });
}
