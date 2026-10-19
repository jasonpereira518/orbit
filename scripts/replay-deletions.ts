/**
 * Re-apply account deletions to a database restored from a backup, BEFORE it is promoted.
 *
 *   DATABASE_URL=<the restored Neon branch> \
 *   TOMBSTONE_SOURCE_URL=<production> \
 *   npx tsx scripts/replay-deletions.ts --since 2026-10-01T03:00:00Z [--apply]
 *
 * `--since` is when the restored dump was taken: every account deleted after it may be in the
 * restored copy. Tombstones are read from production (the restored copy predates them) and the
 * matching accounts and waitlist rows in DATABASE_URL are purged. Without `--apply` it only
 * reports what it would delete. ENCRYPTION_SECRET must be production's: tombstones are keyed
 * hashes (src/lib/deletion-tombstones.ts). Procedure: docs/RUNBOOK.md → Restore the database.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { neon } from "@neondatabase/serverless";
import { replayDeletions, tombstoneHash, type Tombstone } from "../src/lib/deletion-tombstones";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const target = process.env.DATABASE_URL?.trim();
  const source = process.env.TOMBSTONE_SOURCE_URL?.trim();
  const since = arg("since");
  const apply = process.argv.includes("--apply");
  if (!target || !source || !since || Number.isNaN(Date.parse(since))) {
    console.error("Usage: DATABASE_URL=<restored> TOMBSTONE_SOURCE_URL=<production> tsx scripts/replay-deletions.ts --since <ISO time of the dump> [--apply]");
    process.exit(1);
  }
  if (target === source) {
    console.error("DATABASE_URL and TOMBSTONE_SOURCE_URL are the same database — point DATABASE_URL at the RESTORED branch.");
    process.exit(1);
  }

  const rows = (await neon(source).query(
    "SELECT user_id_hash, email_hash, deleted_at FROM deletion_tombstones WHERE deleted_at > $1 ORDER BY deleted_at",
    [new Date(since).toISOString()]
  )) as Array<{ user_id_hash: string; email_hash: string | null; deleted_at: string }>;
  const tombstones: Tombstone[] = rows.map((r) => ({ userIdHash: r.user_id_hash, emailHash: r.email_hash, deletedAt: new Date(r.deleted_at) }));
  console.log(`${tombstones.length} deletion(s) in production since ${since}.`);

  if (!apply) {
    // The waitlist half deletes as it goes; in a dry run, only count matches.
    const { getDb, rowsOf } = await import("../src/db");
    const { sql } = await import("drizzle-orm");
    const db = await getDb();
    const emails = new Set(tombstones.map((t) => t.emailHash).filter(Boolean));
    const signups = rowsOf<{ email: string }>(await db.execute(sql`SELECT email FROM interest_list_signups`));
    const accounts = rowsOf<{ user_id: string; email: string | null }>(await db.execute(sql`SELECT user_id, email FROM user_settings`));
    const ids = new Set(tombstones.map((t) => t.userIdHash));
    const doomed = accounts.filter((a) => ids.has(tombstoneHash(a.user_id)) || (a.email && emails.has(tombstoneHash(a.email))));
    console.log(`DRY RUN: would purge ${doomed.length} restored account(s): ${doomed.map((a) => a.user_id).join(", ") || "none"}`);
    console.log(`DRY RUN: would delete ${signups.filter((s) => emails.has(tombstoneHash(s.email))).length} waitlist row(s). Re-run with --apply.`);
    return;
  }

  // Loaded only when applying, so the dry run never loads the purge at all.
  const { purgeUserData } = await import("../src/lib/user-data");
  const result = await replayDeletions(tombstones, (userId) => purgeUserData(userId, { keepSettings: false }));
  console.log(`Purged ${result.accountsPurged.length} restored account(s): ${result.accountsPurged.join(", ") || "none"}`);
  console.log(`Deleted ${result.waitlistRowsDeleted} waitlist row(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
