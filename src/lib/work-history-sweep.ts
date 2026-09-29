/**
 * The hourly sweep that keeps contacts' work history current.
 *
 * Every contact with a LinkedIn URL has a `work_history_due_at`, set after each check on a
 * closeness-tiered, jittered interval (`nextWorkHistoryDue`) — inner orbit monthly, the long
 * tail twice a year — so the checks are spread over time rather than all landing at once.
 * NULL means never checked, which is due now; closest people go first.
 *
 * ## Fairness and cost
 *
 * Each check is several paid searches on the person's OWN AI key, so the sweep is careful
 * with it:
 *  - an account-level switch (`user_settings.work_history_auto_enabled`) turns it off;
 *  - a background daily budget per account ({@link BACKGROUND_DAILY_LIMIT}), separate from
 *    the allowance LinkedIn pulls and the profile button use, so the sweep never spends the
 *    lookups a person would click for;
 *  - a per-account cap per run, and accounts are interleaved, so one 5,000-contact network
 *    cannot hold the sweep while everyone else waits.
 *
 * ## Claiming
 *
 * The due column is also the lease — the `enrich_due_at` pattern from
 * `lib/events/enrich-queue.ts`. A claim pushes `work_history_due_at` ten minutes out in one
 * UPDATE ... WHERE id IN (SELECT ...), which needs no transaction (neon-http has none), and
 * an invocation killed mid-run leaves its claims to come due again on their own.
 *
 * Auth-free and free of `next/server`: the route wraps it, and the smoke drives it on PGlite.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { userCanUseAi } from "@/lib/ai";
import { consumeBucket, isRateLimitedError, RATE_LIMITS } from "@/lib/rate-limit";
import { utcDayKey } from "@/lib/timeline-cost";
import {
  researchContactWorkHistory,
  type CurrentRoleChecker,
  type WorkHistoryOutcome,
  type WorkHistoryResearcher,
} from "@/lib/work-history-research";

/** Accounts one run looks at. */
export const SWEEP_USERS_PER_RUN = 8;
/** Contacts one run claims per account — the fairness cap. */
export const SWEEP_CLAIM_PER_USER = 3;
/** Background checks per account per UTC day. */
export const BACKGROUND_DAILY_LIMIT = RATE_LIMITS.workHistoryBackground.limit;
/** How long a claim holds a contact before it comes due again on its own. */
const LEASE_MS = 10 * 60 * 1000;
/** People checked at once. Each is 10–40s of searching. */
const SWEEP_CONCURRENCY = 3;

export type WorkHistorySweepStats = {
  users: number;
  claimed: number;
  researched: number;
  saved: number;
  released: number;
  budgetSpent: number;
  noAiUsers: number;
  outcomes: Partial<Record<WorkHistoryOutcome, number>>;
  /** Contact ids whose history was saved, per account — for the route's follow-ons. */
  savedByUser: Record<string, string[]>;
};

export type WorkHistorySweepDeps = {
  now?: Date;
  /** Stop STARTING new checks after this (epoch ms). */
  deadline?: number;
  researcher?: WorkHistoryResearcher;
  checker?: CurrentRoleChecker;
  canUseAi?: (userId: string) => Promise<boolean>;
  random?: () => number;
};

/** Accounts with at least one due contact and the sweep switched on, most overdue first. */
async function usersWithDueContacts(now: Date, limit: number): Promise<string[]> {
  const db = await getDb();
  const rows = rowsOf<{ user_id: string }>(
    await db.execute(sql`
      SELECT c.user_id
        FROM contacts c
        JOIN user_settings s ON s.user_id = c.user_id
       WHERE s.work_history_auto_enabled = 1
         AND c.linkedin_url IS NOT NULL
         AND (c.work_history_due_at IS NULL OR c.work_history_due_at <= ${now})
       GROUP BY c.user_id
       ORDER BY min(coalesce(c.work_history_due_at, '-infinity'::timestamptz)), random()
       LIMIT ${limit}
    `)
  );
  return rows.map((r) => r.user_id);
}

/** Claim this account's most due contacts: never-checked first, then closest first. */
async function claimDueContacts(userId: string, limit: number, now: Date): Promise<string[]> {
  if (limit <= 0) return [];
  const db = await getDb();
  const lease = new Date(now.getTime() + LEASE_MS);
  return rowsOf<{ id: string }>(
    await db.execute(sql`
      UPDATE contacts SET work_history_due_at = ${lease}
       WHERE user_id = ${userId}
         AND (work_history_due_at IS NULL OR work_history_due_at <= ${now})
         AND id IN (
           SELECT id FROM contacts
            WHERE user_id = ${userId}
              AND linkedin_url IS NOT NULL
              AND (work_history_due_at IS NULL OR work_history_due_at <= ${now})
            ORDER BY work_history_due_at ASC NULLS FIRST, closeness DESC NULLS LAST, id
            LIMIT ${limit}
         )
      RETURNING id
    `)
  ).map((r) => r.id);
}

/** Hand claims back, due at `at` — now for "not started", tomorrow for "out of budget". */
async function releaseClaims(userId: string, contactIds: string[], at: Date): Promise<void> {
  if (!contactIds.length) return;
  const db = await getDb();
  await db.execute(sql`
    UPDATE contacts SET work_history_due_at = ${at}
     WHERE user_id = ${userId} AND id IN (${sql.join(contactIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
}

/**
 * An account with no usable AI key cannot be checked; push its whole due backlog out a week
 * in one statement, jittered, rather than re-finding it every hour.
 */
async function deferAccount(userId: string, now: Date): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE contacts
       SET work_history_due_at = ${now}::timestamptz + interval '7 days' * (0.8 + random() * 0.4)
     WHERE user_id = ${userId}
       AND linkedin_url IS NOT NULL
       AND (work_history_due_at IS NULL OR work_history_due_at <= ${now})
  `);
}

function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Round-robin across accounts, so every account's first claim runs before anyone's second. */
function interleave(groups: Array<{ userId: string; ids: string[] }>): Array<{ userId: string; contactId: string }> {
  const out: Array<{ userId: string; contactId: string }> = [];
  for (let i = 0; groups.some((g) => i < g.ids.length); i++) {
    for (const g of groups) if (i < g.ids.length) out.push({ userId: g.userId, contactId: g.ids[i]! });
  }
  return out;
}

export async function runWorkHistorySweep(deps: WorkHistorySweepDeps = {}): Promise<WorkHistorySweepStats> {
  const now = deps.now ?? new Date();
  const canUseAi = deps.canUseAi ?? userCanUseAi;
  const stats: WorkHistorySweepStats = {
    users: 0,
    claimed: 0,
    researched: 0,
    saved: 0,
    released: 0,
    budgetSpent: 0,
    noAiUsers: 0,
    outcomes: {},
    savedByUser: {},
  };

  const users = await usersWithDueContacts(now, SWEEP_USERS_PER_RUN);
  const groups: Array<{ userId: string; ids: string[] }> = [];
  for (const userId of users) {
    if (!(await canUseAi(userId).catch(() => false))) {
      stats.noAiUsers += 1;
      await deferAccount(userId, now);
      continue;
    }
    const ids = await claimDueContacts(userId, SWEEP_CLAIM_PER_USER, now);
    if (!ids.length) continue;
    stats.users += 1;
    stats.claimed += ids.length;
    groups.push({ userId, ids });
  }

  const queue = interleave(groups);
  const exhausted = new Set<string>();
  const unstarted = new Map<string, string[]>();
  const outOfBudget = new Map<string, string[]>();
  let next = 0;

  const worker = async () => {
    while (next < queue.length) {
      const item = queue[next++]!;
      const { userId, contactId } = item;
      const hold = (map: Map<string, string[]>) => map.set(userId, [...(map.get(userId) ?? []), contactId]);
      if (deps.deadline !== undefined && Date.now() >= deps.deadline) {
        hold(unstarted);
        continue;
      }
      if (exhausted.has(userId)) {
        hold(outOfBudget);
        continue;
      }
      const outcome = await researchContactWorkHistory(userId, contactId, {
        researcher: deps.researcher,
        checker: deps.checker,
        now,
        random: deps.random,
        spend: async () => {
          try {
            await consumeBucket(
              "work-history-background",
              `${userId}:${utcDayKey(now)}`,
              RATE_LIMITS.workHistoryBackground
            );
            stats.budgetSpent += 1;
            return true;
          } catch (err) {
            if (isRateLimitedError(err)) return false;
            throw err;
          }
        },
      });
      // Either allowance spent: nothing more for this account today. The contact itself was
      // already rescheduled for the next UTC day by `researchContactWorkHistory`.
      if (outcome === "rate_limited") exhausted.add(userId);
      stats.researched += 1;
      stats.outcomes[outcome] = (stats.outcomes[outcome] ?? 0) + 1;
      if (outcome === "saved") {
        stats.saved += 1;
        (stats.savedByUser[userId] ??= []).push(contactId);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, queue.length) }, () => worker()));

  // Claimed but never started: due again now, for the next run. Out of today's budget: due
  // again when the budget resets.
  for (const [userId, ids] of unstarted) {
    await releaseClaims(userId, ids, now);
    stats.released += ids.length;
  }
  for (const [userId, ids] of outOfBudget) {
    await releaseClaims(userId, ids, nextUtcDay(now));
    stats.released += ids.length;
  }
  return stats;
}
