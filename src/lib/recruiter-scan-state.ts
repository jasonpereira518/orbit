import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { recruiterScanState } from "@/db/schema";

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
 * Decides how far back this run reads.
 *
 * A full scan — first run, an explicit "re-scan everything", or a prompt-version change that
 * stranded the cached verdicts — reaches back `windowMonths`. Everything else resumes from
 * the watermark, which is why a routine re-scan costs a rounding error of the first one.
 */
export async function resolveScanWindow(
  userId: string,
  opts: { full?: boolean } = {}
): Promise<ScanWindow> {
  const state = await getScanState(userId);
  const windowMonths = state?.windowMonths ?? DEFAULT_WINDOW_MONTHS;
  const floor = monthsAgo(windowMonths);

  const stale = (state?.promptVersion ?? 0) !== RECRUITER_PROMPT_VERSION;
  const forced = opts.full === true || !state?.lastScanAt || stale;

  if (forced) {
    return { after: floor, isFull: true, promptVersion: RECRUITER_PROMPT_VERSION, windowMonths };
  }

  // Never resume from before the window floor — shrinking `windowMonths` must not be
  // overridden by an older watermark.
  const resume = daysBefore(state.lastScanAt as Date, INCREMENTAL_OVERLAP_DAYS);
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
