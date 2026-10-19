/**
 * A database restored from a backup must not bring deleted accounts back.
 *
 * Simulates the restore: an account is seeded across every table, its rows are copied aside
 * (the "backup"), the account is deleted (which writes a tombstone), the copied rows are put
 * back (the "restore"), and `replayDeletions` runs with the tombstones. The account — and the
 * waitlist row matched by email — must be gone again, a bystander untouched, and the
 * tombstone must hold no readable id or email.
 *
 * Run: npx tsx scripts/smoke-deletion-replay.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { replayDeletions, pruneDeletionTombstones, tombstoneHash, TOMBSTONE_RETENTION_DAYS } from "../src/lib/deletion-tombstones";
import { purgeUserData } from "../src/lib/user-data";
import { readCatalog } from "../privacy/lib/catalog";
import { scanFor, seedEverything } from "../privacy/lib/seed-everything";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const GONE = "user_replay_gone";
const STAYS = "user_replay_stays";

async function main() {
  const cat = await readCatalog();
  const db = await getDb();
  await seedEverything(cat, GONE);
  await seedEverything(cat, STAYS);
  // The seeder already gave the account a waitlist row under its email (`<id>@example.test`).

  // The "backup": every table's rows for this account, as JSON.
  const tables = [...(await scanFor(cat, GONE)).keys()];
  const backup: Record<string, unknown[]> = {};
  for (const t of tables) {
    backup[t] = rowsOf(await db.execute(sql`SELECT to_jsonb(x) AS row FROM ${sql.identifier(t)} x WHERE x::text LIKE ${`%${GONE}%`}`)).map((r) => (r as { row: unknown }).row);
  }
  check("the backup holds the account in many tables", tables.length >= 50, String(tables.length));

  await purgeUserData(GONE, { keepSettings: false });
  const [stone] = rowsOf<{ user_id_hash: string; email_hash: string | null; deleted_at: string }>(
    await db.execute(sql`SELECT user_id_hash, email_hash, deleted_at FROM deletion_tombstones ORDER BY deleted_at DESC LIMIT 1`)
  );
  check("deleting the account wrote a tombstone", Boolean(stone));
  check("...holding a keyed hash, not the id or email", stone.user_id_hash === tombstoneHash(GONE) && !JSON.stringify(stone).includes(GONE));

  // The "restore": put every backed-up row back, parents first (retry until nothing changes).
  // Generated columns (contacts' sort key, slug and search vector) cannot be inserted, so
  // each table's insertable columns are named — as pg_restore would.
  const insert = (t: string, row: unknown) => {
    const cols = cat.columns.get(t)!.filter((c) => !c.generated).map((c) => sql.identifier(c.column));
    const list = sql.join(cols, sql`, `);
    return db.execute(sql`INSERT INTO ${sql.identifier(t)} (${list}) SELECT ${list} FROM jsonb_populate_record(NULL::${sql.identifier(t)}, ${JSON.stringify(row)}::jsonb) ON CONFLICT DO NOTHING`);
  };
  let pending = Object.entries(backup).flatMap(([t, rows]) => rows.map((row) => ({ t, row })));
  for (let pass = 0; pass < 8 && pending.length; pass++) {
    const next: typeof pending = [];
    for (const item of pending) {
      try {
        await insert(item.t, item.row);
      } catch {
        next.push(item);
      }
    }
    pending = next;
  }
  check("every backed-up row could be put back", pending.length === 0, [...new Set(pending.map((p) => p.t))].join(","));
  const restored = await scanFor(cat, GONE);
  check("the restore brought the account back (the setup is real)", restored.has("user_settings") && restored.has("contacts"));

  const tombstones = rowsOf<{ user_id_hash: string; email_hash: string | null; deleted_at: string }>(
    await db.execute(sql`SELECT user_id_hash, email_hash, deleted_at FROM deletion_tombstones`)
  ).map((r) => ({ userIdHash: r.user_id_hash, emailHash: r.email_hash, deletedAt: new Date(r.deleted_at) }));
  const result = await replayDeletions(tombstones, (id) => purgeUserData(id, { keepSettings: false }));
  check("the replay purged the restored account", result.accountsPurged.includes(GONE), JSON.stringify(result));
  check("...and nobody else", !result.accountsPurged.includes(STAYS));
  const left = await scanFor(cat, GONE);
  const allowed = new Set(["admin_audit_log", "webhook_deliveries", "data_purge_runs", "billing_events", "credit_grants", "page_views", "rate_limit_buckets", "linkedin_avatars", "waitlist_poll_votes"]);
  check("after the replay, nothing of the account is left but the documented records", [...left.keys()].every((t) => allowed.has(t)), [...left.keys()].join(","));
  check("the waitlist row (matched by email) is gone",
    Number(rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM interest_list_signups WHERE lower(email) = ${`${GONE}@example.test`}`))[0].n) === 0);
  check("the bystander is untouched", (await scanFor(cat, STAYS)).has("contacts"));

  console.log("\nPruning");
  check(`tombstones are kept ${TOMBSTONE_RETENTION_DAYS} days`, (await pruneDeletionTombstones(new Date())) === 0);
  check("...and pruned after", (await pruneDeletionTombstones(new Date(Date.now() + (TOMBSTONE_RETENTION_DAYS + 1) * 86_400_000))) >= 1);

  if (failures > 0) throw new Error(`${failures} deletion-replay check(s) failed`);
  console.log("\nAll deletion-replay checks passed.");
}

run(main);
