import { and, eq, isNull, lte, or } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { runFollowUpPass } from "./pass";

/** Matches SYNC_TIME_BUDGET_MS — both routes share the same 300s function ceiling. */
export const FOLLOW_UP_TIME_BUDGET_MS = 4.5 * 60 * 1000;
export const USERS_PER_RUN = 20;
/** Local hour the daily pass targets. */
export const PASS_HOUR_LOCAL = 7;

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

function deadlineReached(deadline: number) {
  return Date.now() >= deadline;
}

/**
 * One scheduler invocation.
 *
 * Structurally a copy of `runSyncPass` in `src/lib/sync-scheduler.ts`: claim a bounded
 * batch, check the budget BEFORE each item rather than after, and report exhaustion so
 * the route can self-continue.
 */
export async function runFollowUpScheduler(
  options: { now?: Date; budgetMs?: number; limit?: number } = {}
): Promise<FollowUpRunStats> {
  const now = options.now ?? new Date();
  const deadline = Date.now() + (options.budgetMs ?? FOLLOW_UP_TIME_BUDGET_MS);
  const db = await getDb();
  const stats: FollowUpRunStats = {
    claimed: 0,
    passed: 0,
    failed: 0,
    written: 0,
    budgetExhausted: false,
  };

  const due = await db.query.userSettings.findMany({
    where: and(
      or(
        isNull(userSettings.followUpNextPassAt),
        lte(userSettings.followUpNextPassAt, now)
      ),
      isNull(userSettings.suspendedAt)
    ),
    columns: { userId: true, timezone: true },
    limit: options.limit ?? USERS_PER_RUN,
  });
  stats.claimed = due.length;

  for (const user of due) {
    // Before the work, never after — a budget checked afterwards bounds nothing.
    if (deadlineReached(deadline)) {
      stats.budgetExhausted = true;
      break;
    }

    // Claim first. If the pass throws, the user is still rescheduled rather than
    // retried on every invocation forever.
    await db
      .update(userSettings)
      .set({ followUpNextPassAt: nextPassAt(user.timezone, now) })
      .where(eq(userSettings.userId, user.userId));

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
