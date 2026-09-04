/**
 * The v27 sync columns survive the path the DDL guard cannot see.
 *
 * `smoke-schema-ddl.ts` regex-slices source text, so DDL that never executes still passes
 * it, and `smoke-schema-upgrade.ts` proves the `CREATE TABLE` template on a fresh database.
 * Neither covers the `alters` list against a database that predates the columns — which is
 * every database already in production. So this drops the six columns and both partial
 * indexes, rewinds the recorded version, and asserts the sweep puts them all back and that
 * they are actually usable: the NOT NULL default applies and `sync_cursor` round-trips as
 * jsonb.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, reconcileSchema, rowsOf, SCHEMA_VERSION } from "../src/db";

const SYNC_COLUMNS = [
  "sync_cursor",
  "next_sync_at",
  "sync_status",
  "sync_started_at",
  "sync_error",
  "sync_failures",
];
const CONNECTION_TABLES = ["gmail_connections", "outlook_connections"];

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Db = Awaited<ReturnType<typeof getDb>>;

async function columnsOf(db: Db, table: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT column_name FROM information_schema.columns WHERE table_name = ${table}
  `);
  return rowsOf<{ column_name: string }>(result).map((r) => r.column_name);
}

async function hasIndex(db: Db, table: string, index: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT indexname FROM pg_indexes WHERE tablename = ${table} AND indexname = ${index}
  `);
  return rowsOf<{ indexname: string }>(result).length === 1;
}

run(async () => {
  const db = await getDb();

  // Rewind to a pre-v27 database: the columns and their indexes simply do not exist.
  for (const table of CONNECTION_TABLES) {
    for (const column of SYNC_COLUMNS) {
      await db.execute(sql.raw(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column}`));
    }
    await db.execute(sql.raw(`DROP INDEX IF EXISTS ${table}_due_idx`));
  }
  for (const table of CONNECTION_TABLES) {
    const present = await columnsOf(db, table);
    check(
      `fixture: ${table} has none of the v27 columns`,
      SYNC_COLUMNS.every((c) => !present.includes(c))
    );
  }
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1}`);

  // The `alters` path — the one neither other guard exercises.
  const result = await reconcileSchema();
  check("the sweep ran", result.applied);
  check("no DDL statement failed", result.failed.length === 0, JSON.stringify(result.failed));

  for (const table of CONNECTION_TABLES) {
    const present = await columnsOf(db, table);
    const missing = SYNC_COLUMNS.filter((c) => !present.includes(c));
    check(`${table}: all six v27 columns restored`, missing.length === 0, missing.join(", "));
    check(`${table}: partial due index restored`, await hasIndex(db, table, `${table}_due_idx`));
  }

  // Present is not the same as usable.
  await db.execute(sql`
    INSERT INTO gmail_connections (user_id, email_address, access_token_encrypted, next_sync_at, sync_cursor)
    VALUES ('smoke-sync-columns', 'a@b.c', 'x', now(), '{"calendar":{"syncToken":"tok"}}'::jsonb)
  `);
  const stored = rowsOf<{ sync_failures: number; tok: string | null }>(
    await db.execute(sql`
      SELECT sync_failures, sync_cursor->'calendar'->>'syncToken' AS tok
      FROM gmail_connections WHERE user_id = 'smoke-sync-columns'
    `)
  )[0];
  check("sync_failures defaults to 0", Number(stored.sync_failures) === 0, String(stored.sync_failures));
  check("sync_cursor round-trips as jsonb", stored.tok === "tok", String(stored.tok));

  // --- The arming backfill is replay-safe ------------------------------------------------
  // It must arm a connection that has never been scheduled, and must NOT re-arm one that the
  // scheduler deliberately disarmed after repeated failure — otherwise every deploy would
  // silently resurrect known-dead connections.
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id IN ('arm-fresh', 'arm-disarmed')`);
  await db.execute(sql`
    INSERT INTO gmail_connections (user_id, email_address, access_token_encrypted, status, next_sync_at)
    VALUES ('arm-fresh', 'f@example.com', 'enc', 'active', NULL),
           ('arm-disarmed', 'd@example.com', 'enc', 'active', NULL)
  `);
  // Stand in for "the scheduler gave up on this one": disarmed, with failures recorded.
  await db.execute(sql`
    UPDATE gmail_connections SET sync_failures = 6, sync_status = 'error', sync_error = 'gave up'
     WHERE user_id = 'arm-disarmed'
  `);
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1}`);
  await reconcileSchema();

  const armed = rowsOf<{ user_id: string; next_sync_at: string | Date | null }>(
    await db.execute(sql`
      SELECT user_id, next_sync_at FROM gmail_connections
       WHERE user_id IN ('arm-fresh', 'arm-disarmed') ORDER BY user_id
    `)
  );
  const disarmedRow = armed.find((r) => r.user_id === 'arm-disarmed');
  const freshRow = armed.find((r) => r.user_id === 'arm-fresh');
  check("an existing connection is armed by the backfill", freshRow?.next_sync_at != null);
  check(
    "a connection the scheduler disarmed is NOT re-armed on replay",
    disarmedRow?.next_sync_at == null,
    String(disarmedRow?.next_sync_at)
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll v27 sync-column checks passed.");
});
