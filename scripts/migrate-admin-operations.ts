/**
 * Adds the central operations hub tables and indexes without touching application data.
 * Uses DATABASE_URL when configured and local PGlite otherwise.
 *
 * Run: npx tsx scripts/migrate-admin-operations.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";

const TABLES: Array<[name: string, ddl: string]> = [
  [
    "operational_events",
    `CREATE TABLE IF NOT EXISTS operational_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      severity text NOT NULL,
      source text NOT NULL,
      event_type text NOT NULL,
      message text NOT NULL,
      success integer,
      user_id text,
      resource_type text,
      resource_id text,
      correlation_id text,
      duration_ms integer,
      dedupe_key text UNIQUE,
      metadata jsonb DEFAULT '{}',
      occurred_at timestamptz NOT NULL DEFAULT now()
    )`,
  ],
  [
    "admin_issues",
    `CREATE TABLE IF NOT EXISTS admin_issues (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      fingerprint text NOT NULL UNIQUE,
      source text NOT NULL,
      severity text NOT NULL,
      state text NOT NULL DEFAULT 'open',
      title text NOT NULL,
      message text NOT NULL,
      target_user_id text,
      resource_type text,
      resource_id text,
      occurrence_count integer NOT NULL DEFAULT 1,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      acknowledged_at timestamptz,
      acknowledged_by text,
      snoozed_until timestamptz,
      resolved_at timestamptz
    )`,
  ],
  [
    "admin_provider_snapshots",
    `CREATE TABLE IF NOT EXISTS admin_provider_snapshots (
      provider text PRIMARY KEY,
      status text NOT NULL,
      summary jsonb DEFAULT '{}',
      error_kind text,
      checked_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    )`,
  ],
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS operational_events_occurred_idx ON operational_events(occurred_at)`,
  `CREATE INDEX IF NOT EXISTS operational_events_source_idx ON operational_events(source, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS operational_events_severity_idx ON operational_events(severity, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS operational_events_user_idx ON operational_events(user_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS operational_events_type_idx ON operational_events(event_type, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS admin_issues_state_idx ON admin_issues(state, severity, last_seen_at)`,
  `CREATE INDEX IF NOT EXISTS admin_issues_target_idx ON admin_issues(target_user_id, last_seen_at)`,
  `CREATE INDEX IF NOT EXISTS admin_provider_snapshots_expires_idx ON admin_provider_snapshots(expires_at)`,
];

async function main() {
  const db = await getDb();
  console.log(
    `Adding admin operations schema (${process.env.DATABASE_URL?.trim() ? "neon" : "pglite"})…`
  );

  for (const [name, ddl] of TABLES) {
    await db.execute(sql.raw(ddl));
    console.log("  ok", name);
  }
  for (const statement of INDEXES) await db.execute(sql.raw(statement));
  console.log(`  ok ${INDEXES.length} indexes`);

  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `);
  const present = new Set(
    rowsOf<{ table_name: string }>(tables).map((row) => row.table_name)
  );
  const missing = TABLES.map(([name]) => name).filter((name) => !present.has(name));
  if (missing.length > 0) throw new Error(`Missing tables: ${missing.join(", ")}`);
  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
