/**
 * Adds the admin console's tables and columns:
 *   - user_settings.comped_note / comped_at / comped_by  (comp provenance)
 *   - user_settings.last_active_at                       (throttled activity stamp)
 *   - usage_events                                       (AI call telemetry)
 *   - admin_audit_log                                    (privileged action trail)
 *
 * Uses DATABASE_URL (Neon) when set, otherwise local PGlite.
 *
 * Deliberately NOT `drizzle-kit push`: push is destructive against the real database
 * because `contact_embeddings.embedding_vector` is created at runtime by the pgvector
 * bootstrap in `src/db/index.ts` and is absent from `schema.ts`, so push proposes
 * dropping it — and its HNSW index — which would destroy semantic search and require
 * re-embedding every contact. Targeted, additive DDL only.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../../../src/db";

const COLUMNS: Array<[column: string, definition: string]> = [
  ["comped_note", "text"],
  ["comped_at", "timestamptz"],
  ["comped_by", "text"],
  ["last_active_at", "timestamptz"],
];

const TABLES: Array<[name: string, ddl: string]> = [
  [
    "usage_events",
    `CREATE TABLE IF NOT EXISTS usage_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      operation text NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      kind text NOT NULL,
      input_tokens integer,
      output_tokens integer,
      cached_input_tokens integer,
      estimated_cost_micros integer,
      key_owner text NOT NULL DEFAULT 'user',
      success integer NOT NULL DEFAULT 1,
      error_kind text,
      duration_ms integer,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  ],
  [
    "admin_audit_log",
    `CREATE TABLE IF NOT EXISTS admin_audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_user_id text NOT NULL,
      action text NOT NULL,
      target_user_id text,
      resource_type text,
      resource_id text,
      detail jsonb DEFAULT '{}',
      reason text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  ],
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS usage_events_user_created_idx ON usage_events(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events(created_at)`,
  `CREATE INDEX IF NOT EXISTS usage_events_model_idx ON usage_events(provider, model)`,
  `CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx ON admin_audit_log(created_at)`,
  `CREATE INDEX IF NOT EXISTS admin_audit_log_target_idx ON admin_audit_log(target_user_id)`,
];

async function main() {
  const mode = process.env.DATABASE_URL?.trim() ? "neon" : "pglite";
  console.log(`Adding admin console tables and columns (${mode})…`);

  const db = await getDb();

  for (const [column, definition] of COLUMNS) {
    await db.execute(
      sql.raw(
        `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ${column} ${definition}`
      )
    );
    console.log("  ok user_settings." + column);
  }

  for (const [name, ddl] of TABLES) {
    await db.execute(sql.raw(ddl));
    console.log("  ok", name);
  }

  for (const statement of INDEXES) {
    await db.execute(sql.raw(statement));
  }
  console.log(`  ok ${INDEXES.length} indexes`);

  // Verify columns landed.
  const present = await db.execute<{ column_name: string }>(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_settings'
  `);
  const have = new Set(
    rowsOf<{ column_name: string }>(present).map((r) => r.column_name)
  );
  const missingColumns = COLUMNS.map(([c]) => c).filter((c) => !have.has(c));
  if (missingColumns.length > 0) {
    throw new Error(
      `Columns still missing after migration: ${missingColumns.join(", ")}`
    );
  }

  // Verify tables landed.
  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
  `);
  const haveTables = new Set(
    rowsOf<{ table_name: string }>(tables).map((r) => r.table_name)
  );
  const missingTables = TABLES.map(([t]) => t).filter((t) => !haveTables.has(t));
  if (missingTables.length > 0) {
    throw new Error(
      `Tables still missing after migration: ${missingTables.join(", ")}`
    );
  }

  // The whole reason this script exists rather than `db:push`.
  const vector = await db.execute<{ column_name: string }>(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'contact_embeddings'
      AND column_name = 'embedding_vector'
  `);
  const vectorRows = rowsOf<unknown>(vector);
  console.log(
    vectorRows.length > 0
      ? "  ok contact_embeddings.embedding_vector still present"
      : "  NOTE contact_embeddings.embedding_vector absent (created at runtime on first embed)"
  );

  console.log("Done.");
}

main()
  .then(() => {
    // The pooled DB connection keeps the event loop alive; exit explicitly.
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
