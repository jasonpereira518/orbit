/**
 * Adds the admin console's instrumentation tables:
 *   - cron_runs           did the nightly job fire, what did it do, did it fail
 *   - webhook_deliveries   every inbound Clerk webhook, including rejected and ignored ones
 *   - error_events         failures that would otherwise vanish into a `catch {}`
 *
 * No new columns: the `gmail_connections.status` / `outlook_connections.status` change that
 * ships alongside this is a TypeScript narrowing with no DDL behind it.
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
import { getDb, rowsOf } from "../src/db";

const TABLES: Array<[name: string, ddl: string]> = [
  [
    "cron_runs",
    `CREATE TABLE IF NOT EXISTS cron_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job text NOT NULL,
      status text NOT NULL DEFAULT 'running',
      trigger text NOT NULL DEFAULT 'schedule',
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      duration_ms integer,
      stats jsonb NOT NULL DEFAULT '{}',
      error text
    )`,
  ],
  [
    "webhook_deliveries",
    `CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source text NOT NULL DEFAULT 'clerk',
      event_id text,
      event_type text,
      outcome text NOT NULL,
      reason text,
      target_user_id text,
      resource_id text,
      detail jsonb NOT NULL DEFAULT '{}',
      error text,
      duration_ms integer,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  ],
  [
    "error_events",
    `CREATE TABLE IF NOT EXISTS error_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source text NOT NULL,
      kind text NOT NULL,
      user_id text,
      message text,
      context jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  ],
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS cron_runs_job_started_idx ON cron_runs(job, started_at)`,
  `CREATE INDEX IF NOT EXISTS cron_runs_started_idx ON cron_runs(started_at)`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_created_idx ON webhook_deliveries(created_at)`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_event_idx ON webhook_deliveries(event_id)`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_target_idx ON webhook_deliveries(target_user_id)`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_type_created_idx ON webhook_deliveries(event_type, created_at)`,
  `CREATE INDEX IF NOT EXISTS error_events_created_idx ON error_events(created_at)`,
  `CREATE INDEX IF NOT EXISTS error_events_source_created_idx ON error_events(source, created_at)`,
  `CREATE INDEX IF NOT EXISTS error_events_user_created_idx ON error_events(user_id, created_at)`,
];

async function main() {
  const mode = process.env.DATABASE_URL?.trim() ? "neon" : "pglite";
  console.log(`Adding instrumentation tables (${mode})…`);

  const db = await getDb();

  for (const [name, ddl] of TABLES) {
    await db.execute(sql.raw(ddl));
    console.log("  ok", name);
  }

  for (const statement of INDEXES) {
    await db.execute(sql.raw(statement));
  }
  console.log(`  ok ${INDEXES.length} indexes`);

  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
  `);
  const have = new Set(
    rowsOf<{ table_name: string }>(tables).map((r) => r.table_name)
  );
  const missing = TABLES.map(([t]) => t).filter((t) => !have.has(t));
  if (missing.length > 0) {
    throw new Error(`Tables still missing after migration: ${missing.join(", ")}`);
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
