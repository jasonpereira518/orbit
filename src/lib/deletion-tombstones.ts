import { createHmac, hkdfSync } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { deletionTombstones } from "@/db/schema";

/**
 * Deletions must survive a database restore.
 *
 * Backups are kept for 90 days (docs/RUNBOOK.md). Restoring one taken before an account was
 * deleted would silently bring that account back — every contact, note and token — and
 * nothing recorded which deletions to redo: `data_purge_runs`, the only ledger, was pruned
 * after 30 days and names the account in clear. A tombstone is the minimum needed to redo
 * the deletion on a restored copy: a keyed hash of the account id and of its email, and when.
 *
 * Keyed (HMAC, with a subkey derived from ENCRYPTION_SECRET) rather than a plain hash: an
 * email's plain SHA-256 is one dictionary lookup away from the address. Matching a restored
 * database means hashing ITS ids and emails with the same key, so the tombstone never needs
 * the values. The key must therefore be the production one when replaying.
 *
 * Kept TOMBSTONE_RETENTION_DAYS (longer than any backup), then pruned.
 */
export const TOMBSTONE_RETENTION_DAYS = 120;

let cachedKey: { secret: string; key: Buffer } | null = null;

function tombstoneKey(): Buffer {
  let secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("ENCRYPTION_SECRET must be set in production to write deletion tombstones");
    }
    secret = "orbit-dev-secret-change-me-in-prod";
  }
  if (cachedKey?.secret !== secret) {
    cachedKey = {
      secret,
      key: Buffer.from(hkdfSync("sha256", secret, "orbit-deletion-tombstones", "v1", 32)),
    };
  }
  return cachedKey.key;
}

export function tombstoneHash(value: string): string {
  return createHmac("sha256", tombstoneKey()).update(value.trim().toLowerCase()).digest("hex");
}

/** Called by the purge's `account` step, before the settings row (and its email) is deleted. */
export async function writeDeletionTombstone(userId: string, email: string | null | undefined): Promise<void> {
  const db = await getDb();
  await db.insert(deletionTombstones).values({
    userIdHash: tombstoneHash(userId),
    emailHash: email ? tombstoneHash(email) : null,
  });
}

/** Hourly: drop tombstones older than every backup that could still be restored. */
export async function pruneDeletionTombstones(now: Date): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - TOMBSTONE_RETENTION_DAYS * 86_400_000);
  const removed = await db.delete(deletionTombstones).where(lt(deletionTombstones.deletedAt, cutoff)).returning();
  return removed.length;
}

export type Tombstone = { userIdHash: string; emailHash: string | null; deletedAt: Date };

export type ReplayResult = {
  tombstones: number;
  accountsPurged: string[];
  waitlistRowsDeleted: number;
};

/**
 * Re-apply deletions to the database `getDb()` points at — a RESTORED copy — from tombstones
 * read from production (the restored copy predates them, so it cannot hold them itself).
 *
 * Every account in the restored copy whose id or email hashes to a tombstone is purged in full
 * (`purgeUserData`, `keepSettings: false`, which also re-queues any Stripe cancel), and
 * waitlist rows are matched by email for the people who never had an account row. `purge` is
 * injected so the smoke test can run it without a cycle back into `user-data.ts`.
 */
export async function replayDeletions(
  tombstones: readonly Tombstone[],
  purge: (userId: string) => Promise<unknown>
): Promise<ReplayResult> {
  const db = await getDb();
  const ids = new Set(tombstones.map((t) => t.userIdHash));
  const emails = new Set(tombstones.map((t) => t.emailHash).filter((h): h is string => Boolean(h)));
  const result: ReplayResult = { tombstones: tombstones.length, accountsPurged: [], waitlistRowsDeleted: 0 };
  if (tombstones.length === 0) return result;

  const accounts = rowsOf<{ user_id: string; email: string | null }>(
    await db.execute(sql`SELECT user_id, email FROM user_settings`)
  );
  for (const account of accounts) {
    const byId = ids.has(tombstoneHash(account.user_id));
    const byEmail = account.email ? emails.has(tombstoneHash(account.email)) : false;
    if (!byId && !byEmail) continue;
    await purge(account.user_id);
    result.accountsPurged.push(account.user_id);
  }

  const signups = rowsOf<{ id: string; email: string }>(
    await db.execute(sql`SELECT id, email FROM interest_list_signups`)
  );
  const doomed = signups.filter((s) => emails.has(tombstoneHash(s.email))).map((s) => s.id);
  if (doomed.length > 0) {
    const list = sql`ARRAY[${sql.join(doomed.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[]`;
    await db.execute(sql`UPDATE interest_list_signups SET referred_by_id = NULL WHERE referred_by_id = ANY(${list})`);
    await db.execute(sql`DELETE FROM waitlist_poll_votes WHERE signup_id = ANY(${list})`);
    await db.execute(sql`DELETE FROM broadcast_recipients WHERE signup_id = ANY(${list})`);
    const deleted = rowsOf(await db.execute(sql`DELETE FROM interest_list_signups WHERE id = ANY(${list}) RETURNING id`));
    result.waitlistRowsDeleted = deleted.length;
  }
  return result;
}
