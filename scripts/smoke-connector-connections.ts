/**
 * The generic connector table: its DDL, its unique index, and the claim predicate the
 * scheduler depends on.
 *
 * The `alters` path is exercised explicitly — it is the one neither smoke-schema-ddl (which
 * never touches a database) nor a fresh bootstrap (which only runs the CREATE TABLE) covers,
 * and it is the path every already-deployed database actually takes.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, reconcileSchema, rowsOf, SCHEMA_VERSION } from "../src/db";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

run(async () => {
  const db = await getDb();

  console.log("schema version");
  check("SCHEMA_VERSION is at least 74", SCHEMA_VERSION >= 74, String(SCHEMA_VERSION));

  console.log("\nthe alters path rebuilds the table on an existing database");
  await db.execute(sql.raw(`DROP TABLE IF EXISTS connector_connections`));
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1}`);
  const result = await reconcileSchema();
  check("the sweep ran", result.applied);
  check("no DDL statement failed", result.failed.length === 0, JSON.stringify(result.failed));

  const cols = rowsOf<{ column_name: string }>(
    await db.execute(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'connector_connections'
    `)
  ).map((r) => r.column_name);
  for (const column of [
    "id", "user_id", "connector_id", "auth_kind", "label", "account_ref",
    "api_key_encrypted", "access_token_encrypted", "refresh_token_encrypted",
    "token_expires_at", "scopes", "capabilities", "status", "last_synced_at",
    "sync_cursor", "next_sync_at", "sync_status", "sync_started_at", "sync_error",
    "sync_failures", "created_at", "updated_at",
  ]) {
    check(`column ${column} exists`, cols.includes(column));
  }

  const idx = rowsOf<{ indexname: string }>(
    await db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'connector_connections'`)
  ).map((r) => r.indexname);
  check("the user/connector unique index exists", idx.includes("connector_connections_user_uidx"));
  check("the due index exists", idx.includes("connector_connections_due_idx"));

  console.log("\none row per user per connector");
  await db.execute(sql`
    INSERT INTO connector_connections (user_id, connector_id, auth_kind)
    VALUES ('smoke-user', 'hubspot', 'oauth2')
  `);
  let rejected = false;
  try {
    await db.execute(sql`
      INSERT INTO connector_connections (user_id, connector_id, auth_kind)
      VALUES ('smoke-user', 'hubspot', 'oauth2')
    `);
  } catch {
    rejected = true;
  }
  check("a second row for the same connector is rejected", rejected);

  await db.execute(sql`DELETE FROM connector_connections WHERE user_id = 'smoke-user'`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector_connections checks passed.");
});
