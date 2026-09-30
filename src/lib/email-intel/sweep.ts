/**
 * The email-insights sweep: every fifteen minutes, read the new career-relevant Gmail threads
 * of each opted-in account, judge them by rule, and record what they say.
 *
 * ## Claiming
 * `user_settings.email_intel_next_at` is both the schedule and the lease (the pattern of
 * `work_history_due_at`): a claim pushes it ten minutes out in one UPDATE ... RETURNING, which
 * needs no transaction, and a killed invocation's accounts come due again on their own.
 *
 * ## Progress
 * The watermark (`email_intel_cursor_at`) moves to the sweep's START, and only when the whole
 * window was processed. Cut short by the daily cap or the time budget, it stays put and the
 * next run re-lists the same window: threads already stored are skipped free (their newest
 * listed message id equals the stored one), so each run goes further than the last.
 *
 * ## Cost
 * Metadata only, no body, no model. The daily cap charges threads fetched, not threads listed.
 *
 * Auth-free and free of `next/server`: the route wraps it and the smoke drives it on PGlite.
 */
import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { gmailConnections } from "@/db/schema";
import { getEntitlements } from "@/lib/entitlements";
import { ReauthRequiredError } from "@/lib/errors";
import {
  buildRecruiterQuery,
  fetchGmailThreadsBatched,
  getValidAccessToken,
  listGmailMessagePage,
  type GmailMessageRef,
  type GmailThreadSummary,
} from "@/lib/gmail";
import { hasGmailReadScope } from "@/lib/google-scopes";
import { consumeBucket, isRateLimitedError, RATE_LIMITS } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { utcDayKey } from "@/lib/timeline-cost";
import { knownThreadVersions, upsertThreadResult } from "./store";
import { assessThread } from "./triage";

const DAY_MS = 86_400_000;
/** Accounts one run looks at. */
export const SWEEP_USERS_PER_RUN = 6;
/** A claim holds an account this long before it comes due again on its own. */
const LEASE_MS = 10 * 60_000;
/** Cadence between complete sweeps of one account. */
export const INTERVAL_MS = 15 * 60_000;
/** An account with no mail access, no plan, or a dead grant is looked at again after a day. */
export const DEFER_MS = DAY_MS;
/** After an unexpected error: try again in an hour. */
const ERROR_BACKOFF_MS = 60 * 60_000;
/** First run: how far back to look. */
export const BACKFILL_DAYS = 14;
/** Gmail's `after:` is date-granular, so re-read a little before the watermark. */
export const OVERLAP_DAYS = 2;
/** Messages listed per account per run (newest first). */
export const MAX_LISTED = 1000;
const LIST_PAGE = 100;
/** Threads fetched per Gmail batch call (Google recommends 50). */
export const THREAD_BATCH = 50;

export type EmailIntelGmail = {
  accessToken(userId: string): Promise<string>;
  listPage(
    token: string,
    opts: { query: string; pageToken: string | null; maxResults: number }
  ): Promise<{ messages: GmailMessageRef[]; nextPageToken: string | null }>;
  fetchThreads(token: string, threadIds: string[]): Promise<GmailThreadSummary[]>;
};

export type EmailIntelConnection = { email: string; canRead: boolean };

export type EmailIntelDeps = {
  now?: Date;
  /** Stop STARTING work after this (epoch ms). */
  deadline?: number;
  gmail?: EmailIntelGmail;
  connection?: (userId: string) => Promise<EmailIntelConnection | null>;
  eligible?: (userId: string) => Promise<boolean>;
};

export type EmailIntelSweepStats = {
  accounts: number;
  deferred: number;
  listed: number;
  fetched: number;
  stored: number;
  skipped: number;
  unchanged: number;
  exhausted: number;
  partial: number;
  errors: number;
};

const liveGmail: EmailIntelGmail = {
  accessToken: (userId) => getValidAccessToken(userId),
  listPage: (token, opts) => listGmailMessagePage(token, opts),
  fetchThreads: (token, ids) => fetchGmailThreadsBatched(token, ids),
};

async function loadConnection(userId: string): Promise<EmailIntelConnection | null> {
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { emailAddress: true, scopes: true, status: true },
  });
  if (!conn) return null;
  return { email: conn.emailAddress, canRead: conn.status === "active" && hasGmailReadScope(conn.scopes) };
}

/** Background code must not use `requireEntitlement`: it records a gate hit and throws. */
async function planAllows(userId: string): Promise<boolean> {
  try {
    return (await getEntitlements(userId)).canUseRecruiters === true;
  } catch {
    return false;
  }
}

function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

type Claimed = { userId: string; cursorAt: Date | null };

async function claimAccounts(now: Date, limit: number): Promise<Claimed[]> {
  const db = await getDb();
  const lease = new Date(now.getTime() + LEASE_MS);
  const rows = rowsOf<{ user_id: string; email_intel_cursor_at: string | Date | null }>(
    await db.execute(sql`
      UPDATE user_settings SET email_intel_next_at = ${lease}
       WHERE email_intel_enabled = 1
         AND (email_intel_next_at IS NULL OR email_intel_next_at <= ${now})
         AND user_id IN (
           SELECT user_id FROM user_settings
            WHERE email_intel_enabled = 1
              AND (email_intel_next_at IS NULL OR email_intel_next_at <= ${now})
            ORDER BY email_intel_next_at ASC NULLS FIRST, user_id
            LIMIT ${limit}
         )
      RETURNING user_id, email_intel_cursor_at
    `)
  );
  return rows.map((r) => ({
    userId: r.user_id,
    cursorAt: r.email_intel_cursor_at ? new Date(r.email_intel_cursor_at) : null,
  }));
}

type Settle = { nextAt: Date; cursorAt: Date | null };

async function settle(userId: string, s: Settle): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE user_settings
       SET email_intel_next_at = ${s.nextAt},
           email_intel_cursor_at = COALESCE(${s.cursorAt}::timestamptz, email_intel_cursor_at)
     WHERE user_id = ${userId}
  `);
}

async function processAccount(
  acct: Claimed,
  d: Required<Pick<EmailIntelDeps, "gmail" | "connection" | "eligible">> & Pick<EmailIntelDeps, "deadline">,
  now: Date,
  stats: EmailIntelSweepStats
): Promise<Settle> {
  const { userId } = acct;
  const conn = await d.connection(userId);
  if (!conn || !conn.canRead || !(await d.eligible(userId))) {
    stats.deferred += 1;
    return { nextAt: new Date(now.getTime() + DEFER_MS), cursorAt: null };
  }
  const token = await d.gmail.accessToken(userId);

  const start = acct.cursorAt ?? new Date(now.getTime() - BACKFILL_DAYS * DAY_MS);
  const query = buildRecruiterQuery({ after: new Date(start.getTime() - OVERLAP_DAYS * DAY_MS) });

  // Newest listed message per thread. Listing is newest first.
  const newest = new Map<string, string>();
  let pageToken: string | null = null;
  let listed = 0;
  do {
    const page = await d.gmail.listPage(token, {
      query,
      pageToken,
      maxResults: Math.min(LIST_PAGE, MAX_LISTED - listed),
    });
    for (const ref of page.messages) {
      listed += 1;
      if (!newest.has(ref.threadId)) newest.set(ref.threadId, ref.id);
    }
    pageToken = page.nextPageToken;
  } while (pageToken && listed < MAX_LISTED);
  stats.listed += listed;

  const known = await knownThreadVersions(userId, [...newest.keys()]);
  const todo = [...newest].filter(([threadId, messageId]) => known.get(threadId) !== messageId).map(([id]) => id);
  stats.unchanged += newest.size - todo.length;

  let stoppedBy: "budget" | "time" | null = null;
  for (let i = 0; i < todo.length; i += THREAD_BATCH) {
    if (d.deadline !== undefined && Date.now() >= d.deadline) {
      stoppedBy = "time";
      break;
    }
    const chunk = todo.slice(i, i + THREAD_BATCH);
    try {
      await consumeBucket("email-intel-daily", `${userId}:${utcDayKey(now)}`, RATE_LIMITS.emailIntelDaily, chunk.length);
    } catch (err) {
      if (isRateLimitedError(err)) {
        stoppedBy = "budget";
        break;
      }
      throw err;
    }
    const threads = await d.gmail.fetchThreads(token, chunk);
    stats.fetched += threads.length;
    for (const thread of threads) {
      const result = assessThread(thread, conn.email);
      if (!result.lastMessageId) continue;
      const { changed } = await upsertThreadResult(userId, result);
      if (!changed) stats.unchanged += 1;
      else if (result.decision === "skipped") stats.skipped += 1;
      else stats.stored += 1;
    }
  }

  if (stoppedBy === "budget") {
    stats.exhausted += 1;
    return { nextAt: nextUtcDay(now), cursorAt: null };
  }
  if (stoppedBy === "time") {
    stats.partial += 1;
    return { nextAt: now, cursorAt: null };
  }
  return { nextAt: new Date(now.getTime() + INTERVAL_MS), cursorAt: now };
}

export async function runEmailIntelSweep(deps: EmailIntelDeps = {}): Promise<EmailIntelSweepStats> {
  const now = deps.now ?? new Date();
  const d = {
    gmail: deps.gmail ?? liveGmail,
    connection: deps.connection ?? loadConnection,
    eligible: deps.eligible ?? planAllows,
    deadline: deps.deadline,
  };
  const stats: EmailIntelSweepStats = {
    accounts: 0, deferred: 0, listed: 0, fetched: 0, stored: 0, skipped: 0, unchanged: 0, exhausted: 0, partial: 0, errors: 0,
  };

  const claimed = await claimAccounts(now, SWEEP_USERS_PER_RUN);
  stats.accounts = claimed.length;
  for (const acct of claimed) {
    if (d.deadline !== undefined && Date.now() >= d.deadline) {
      // Claimed but never started: due again now, for the next run.
      await settle(acct.userId, { nextAt: now, cursorAt: null });
      continue;
    }
    let outcome: Settle;
    try {
      outcome = await processAccount(acct, d, now, stats);
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        stats.deferred += 1;
        outcome = { nextAt: new Date(now.getTime() + DEFER_MS), cursorAt: null };
      } else {
        stats.errors += 1;
        reportError(err, { where: "email-intel.sweep", extra: { userId: acct.userId } });
        outcome = { nextAt: new Date(now.getTime() + ERROR_BACKOFF_MS), cursorAt: null };
      }
    }
    await settle(acct.userId, outcome);
  }
  return stats;
}
