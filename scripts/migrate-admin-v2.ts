/**
 * Adds the admin console v2 schema:
 *   - user_settings.suspended_at / suspended_reason / suspended_by  (operator suspension)
 *   - admin_reveal_grants                                          (audited unmask grants)
 *   - the cross-user aggregation indexes the roster, trends and health screens need
 *
 * Uses DATABASE_URL (Neon) when set, otherwise local PGlite.
 *
 * Deliberately NOT `drizzle-kit push`, for the reason `scripts/migrate-admin-tables.ts`
 * documents at length: push proposes dropping `contact_embeddings.embedding_vector` and its
 * HNSW index, because both are created at runtime by the pgvector bootstrap in
 * `src/db/index.ts` and are absent from `schema.ts`. Targeted, additive DDL only.
 *
 * Run: npx tsx scripts/migrate-admin-v2.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";

const COLUMNS: Array<[column: string, definition: string]> = [
  ["suspended_at", "timestamptz"],
  ["suspended_reason", "text"],
  ["suspended_by", "text"],
];

const TABLES: Array<[name: string, ddl: string]> = [
  [
    "admin_reveal_grants",
    `CREATE TABLE IF NOT EXISTS admin_reveal_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_user_id text NOT NULL,
      target_user_id text NOT NULL,
      reason text NOT NULL,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  ],
];

/**
 * Order matters: the `user_settings` indexes cover columns added by earlier migrations, so
 * this runs after the COLUMNS pass above and after `migrate-admin-tables.ts`.
 */
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS admin_reveal_grants_lookup_idx ON admin_reveal_grants(admin_user_id, target_user_id, expires_at)`,
  `CREATE INDEX IF NOT EXISTS admin_reveal_grants_target_idx ON admin_reveal_grants(target_user_id)`,
  `CREATE INDEX IF NOT EXISTS admin_audit_log_action_idx ON admin_audit_log(action, created_at)`,
  // `imports` had no user_id index at all, which made the roster fan-out a sequential scan.
  `CREATE INDEX IF NOT EXISTS imports_user_created_idx ON imports(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS imports_status_updated_idx ON imports(status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS contacts_user_created_idx ON contacts(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS interactions_user_created_idx ON interactions(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS chat_messages_user_created_idx ON chat_messages(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS user_settings_created_idx ON user_settings(created_at)`,
  `CREATE INDEX IF NOT EXISTS user_settings_email_idx ON user_settings(email)`,
  `CREATE INDEX IF NOT EXISTS user_settings_last_active_idx ON user_settings(last_active_at)`,
  // Partial: failures are a small slice of the table and the triage screen only reads it.
  `CREATE INDEX IF NOT EXISTS usage_events_failures_idx ON usage_events(user_id, created_at) WHERE success = 0`,
];

async function main() {
  const mode = process.env.DATABASE_URL?.trim() ? "neon" : "pglite";
  console.log(`Adding admin console v2 schema (${mode})…`);

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

  const indexes = await db.execute<{ indexname: string }>(sql`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
  `);
  const haveIndexes = new Set(
    rowsOf<{ indexname: string }>(indexes).map((r) => r.indexname)
  );
  const missingIndexes = INDEXES.map(
    (s) => s.match(/IF NOT EXISTS (\w+)/)?.[1] ?? ""
  ).filter((n) => n && !haveIndexes.has(n));
  if (missingIndexes.length > 0) {
    throw new Error(
      `Indexes still missing after migration: ${missingIndexes.join(", ")}`
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
  console.log(
    rowsOf<unknown>(vector).length > 0
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
