import { and, like, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { purgeUserData } from "@/lib/user-data";

/**
 * Reconciles `user_settings` against Clerk, for the deletions the `user.deleted` webhook never
 * delivered. Clerk is injected (`lookup`) so this module needs no `@clerk/nextjs/server`
 * import — that reaches `next/server` and would hang every script that loads it.
 */
export const ORPHAN_INACTIVE_DAYS = 7;
export const ORPHAN_LOOKUP_BATCH = 100;
export const ORPHAN_MAX_CANDIDATES = 300;
export const ORPHAN_MAX_PURGES = 25;
const ABORT_MIN_MISSING = 10;
const ABORT_RATIO = 0.5;

/** Returns the subset of `userIds` that Clerk still has. */
export type ExistingClerkUsers = (userIds: string[]) => Promise<Set<string>>;

export async function sweepOrphanedAccounts(opts: {
  lookup: ExistingClerkUsers;
  now: Date;
  maxCandidates?: number;
  maxPurges?: number;
  purge?: (userId: string) => Promise<unknown>;
}) {
  const purge = opts.purge ?? ((userId: string) => purgeUserData(userId, { keepSettings: false }));
  const maxPurges = opts.maxPurges ?? ORPHAN_MAX_PURGES;
  const cutoff = new Date(opts.now.getTime() - ORPHAN_INACTIVE_DAYS * 24 * 60 * 60 * 1000);
  const result = { examined: 0, orphaned: 0, purged: 0, purgeErrors: 0, aborted: false };

  const db = await getDb();
  // Random order so a large roster is covered over successive nights instead of the same
  // oldest 300 forever. `user_` prefix: only real Clerk ids — never the local demo account
  // or smoke fixtures that share a database.
  const candidates = await db
    .select({ userId: userSettings.userId })
    .from(userSettings)
    .where(
      and(
        like(userSettings.userId, "user\\_%"),
        lt(sql`coalesce(${userSettings.lastActiveAt}, ${userSettings.createdAt})`, cutoff)
      )
    )
    .orderBy(sql`random()`)
    .limit(opts.maxCandidates ?? ORPHAN_MAX_CANDIDATES);

  const ids = candidates.map((c) => c.userId);
  for (let i = 0; i < ids.length; i += ORPHAN_LOOKUP_BATCH) {
    const batch = ids.slice(i, i + ORPHAN_LOOKUP_BATCH);
    const existing = await opts.lookup(batch);
    result.examined += batch.length;
    const missing = batch.filter((id) => !existing.has(id));
    if (missing.length >= ABORT_MIN_MISSING && missing.length / batch.length > ABORT_RATIO) {
      // A wrong-instance secret or a Clerk incident, not a wave of deletions. Stop cold.
      result.aborted = true;
      return result;
    }
    result.orphaned += missing.length;
    for (const userId of missing) {
      if (result.purged + result.purgeErrors >= maxPurges) break;
      try {
        await purge(userId);
        result.purged += 1;
      } catch {
        // The purge run is recorded; the nightly resume (or purge.stuck) takes it from here.
        result.purgeErrors += 1;
      }
    }
  }
  return result;
}
