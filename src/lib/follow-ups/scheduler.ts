import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { userSettings } from "@/db/schema";
import { deadlineAfter, deadlineReached } from "@/lib/time-budget";
import { runFollowUpPass } from "./pass";

/** Matches SYNC_TIME_BUDGET_MS — both routes share the same 300s function ceiling. */
export const FOLLOW_UP_TIME_BUDGET_MS = 4.5 * 60 * 1000;
export const USERS_PER_RUN = 20;
/** Local hour the daily pass targets. */
export const PASS_HOUR_LOCAL = 7;

/**
 * How long a bulk claim is honoured before another run may take the row, mirroring
 * `SYNC_LEASE_MS` in `provider-connections.ts`. Comfortably longer than the 300s function
 * ceiling, so a run that is merely slow — or the route's own self-continuation racing the
 * next hourly invocation — is never stolen from mid-flight. The claim written here is a
 * provisional placeholder; each user's real next-pass time (computed from their timezone)
 * overwrites it once they are actually processed, below.
 */
export const CLAIM_LEASE_MS = 10 * 60 * 1000;

export type FollowUpRunStats = {
  claimed: number;
  passed: number;
  failed: number;
  written: number;
  budgetExhausted: boolean;
};

/**
 * The next 07:00 in the user's zone, as an absolute instant.
 *
 * A null timezone falls back to UTC: degraded (the pass lands at an arbitrary local
 * hour) but correct, and never a reason to skip a user entirely.
 */
export function nextPassAt(timezone: string | null, now: Date): Date {
  const zone = timezone || "UTC";
  // Read the wall-clock hour in the target zone by formatting, which is the only way
  // to do this without pulling in a timezone library.
  let localHour: number;
  try {
    localHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hour: "numeric",
        hour12: false,
      }).format(now)
    );
  } catch {
    // An invalid IANA string must not throw the whole pass. Treat it as UTC.
    localHour = now.getUTCHours();
  }

  const hoursUntil = (PASS_HOUR_LOCAL - localHour + 24) % 24 || 24;
  return new Date(now.getTime() + hoursUntil * 60 * 60 * 1000);
}

type ClaimedUser = { userId: string; timezone: string | null };

type ClaimRow = { user_id: string; timezone: string | null };

/**
 * Claim up to `limit` due users in one atomic statement, following `claimDueConnections`'s
 * shape in `provider-connections.ts`: the SELECT and the claiming UPDATE are the same
 * statement, so two overlapping scheduler runs — the route's own self-continuation racing
 * the next hourly invocation — cannot both select the same row before either has claimed
 * it. A second run blocking on the same row re-evaluates the predicate under READ
 * COMMITTED once the first commits, and skips it.
 */
async function claimDueUsers(limit: number, now: Date): Promise<ClaimedUser[]> {
  const db = await getDb();
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS);

  const claimed = await db.execute(sql`
    UPDATE user_settings
       SET follow_up_next_pass_at = ${leaseUntil}
     WHERE user_id IN (
       SELECT user_id FROM user_settings
        WHERE (follow_up_next_pass_at IS NULL OR follow_up_next_pass_at <= ${now})
          AND suspended_at IS NULL
        ORDER BY follow_up_next_pass_at NULLS FIRST
        LIMIT ${limit}
     )
    RETURNING user_id, timezone
  `);

  return rowsOf<ClaimRow>(claimed).map((row) => ({
    userId: row.user_id,
    timezone: row.timezone,
  }));
}

/**
 * One scheduler invocation.
 *
 * Structurally a copy of `runSyncPass` in `src/lib/sync-scheduler.ts`: claim a bounded
 * batch atomically, check the budget BEFORE each item rather than after, and report
 * exhaustion so the route can self-continue. One user's failure — whether in the claim's
 * own reschedule write or in the pass itself — must never stop everyone else's run, so
 * both are caught and counted rather than left to escape the loop.
 */
export async function runFollowUpScheduler(
  options: { now?: Date; budgetMs?: number; limit?: number } = {}
): Promise<FollowUpRunStats> {
  const now = options.now ?? new Date();
  const deadline = deadlineAfter(options.budgetMs ?? FOLLOW_UP_TIME_BUDGET_MS);
  const db = await getDb();
  const stats: FollowUpRunStats = {
    claimed: 0,
    passed: 0,
    failed: 0,
    written: 0,
    budgetExhausted: false,
  };

  const due = await claimDueUsers(options.limit ?? USERS_PER_RUN, now);
  stats.claimed = due.length;

  for (const user of due) {
    // Before the work, never after — a budget checked afterwards bounds nothing.
    if (deadlineReached(deadline)) {
      stats.budgetExhausted = true;
      // Release the claim so the next invocation — the route's own self-continuation, or
      // the next hourly run — picks this user up immediately rather than waiting out the
      // lease.
      await db
        .update(userSettings)
        .set({ followUpNextPassAt: now })
        .where(eq(userSettings.userId, user.userId))
        .catch(() => null);
      continue;
    }

    // Reschedule to the real next local 07:00 before doing any work. If this write throws,
    // the user is counted as a failure and skipped this cycle rather than aborting the run
    // for everyone queued behind them — the same invariant `sync-scheduler.ts` states for
    // its own per-connection claim.
    try {
      await db
        .update(userSettings)
        .set({ followUpNextPassAt: nextPassAt(user.timezone, now) })
        .where(eq(userSettings.userId, user.userId));
    } catch (err) {
      stats.failed += 1;
      console.error(`follow-ups: claim failed for ${user.userId}`, err);
      continue;
    }

    try {
      const result = await runFollowUpPass(user.userId, { now });
      stats.passed += 1;
      stats.written += result.written;
    } catch (err) {
      stats.failed += 1;
      console.error(`follow-ups: pass failed for ${user.userId}`, err);
    }
  }

  return stats;
}
