/**
 * Adds the two tables behind provider status and upgrade celebrations:
 *   - admin_provider_snapshots  (cached per-provider health check)
 *   - plan_upgrade_events       (durable, once-only celebration queue)
 *
 * Uses DATABASE_URL (Neon) when set, otherwise local PGlite.
 *
 * Deliberately NOT `drizzle-kit push`, for the reason the archived admin migrations
 * document: push proposes dropping `contact_embeddings.embedding_vector` and its HNSW
 * index, because both are created at runtime by the pgvector bootstrap in `src/db/index.ts`
 * and are absent from `schema.ts`. Targeted, additive DDL only.
 *
 * Run: npx tsx scripts/migrate-provider-and-upgrade-events.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";

const TABLES: Array<[name: string, ddl: string]> = [
  [
    "plan_upgrade_events",
    `CREATE TABLE IF NOT EXISTS plan_upgrade_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      plan text NOT NULL,
      source text NOT NULL,
      event_key text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      claimed_at timestamptz
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

/**
 * The partial unique index is what stops two concurrent webhook deliveries queuing
 * duplicate celebrations for the same plan, while still allowing a later downgrade and
 * re-upgrade once the first row is claimed. It is not optional.
 */
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS plan_upgrade_events_claim_idx ON plan_upgrade_events(user_id, claimed_at, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS plan_upgrade_events_pending_uidx ON plan_upgrade_events(user_id, plan) WHERE claimed_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS admin_provider_snapshots_expires_idx ON admin_provider_snapshots(expires_at)`,
];

async function main() {
  const mode = process.env.DATABASE_URL?.trim() ? "neon" : "pglite";
  console.log(`Adding provider-status and upgrade-event tables (${mode})…`);

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
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `);
  const have = new Set(
    rowsOf<{ table_name: string }>(tables).map((r) => r.table_name)
  );
  const missing = TABLES.map(([t]) => t).filter((t) => !have.has(t));
  if (missing.length > 0) {
    throw new Error(`Tables still missing after migration: ${missing.join(", ")}`);
  }

  const indexes = await db.execute<{ indexname: string }>(sql`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
  `);
  const haveIdx = new Set(
    rowsOf<{ indexname: string }>(indexes).map((r) => r.indexname)
  );
  const missingIdx = INDEXES.map(
    (s) => s.match(/IF NOT EXISTS (\w+)/)?.[1] ?? ""
  ).filter((n) => n && !haveIdx.has(n));
  if (missingIdx.length > 0) {
    throw new Error(`Indexes still missing: ${missingIdx.join(", ")}`);
  }

  // The whole reason this script exists rather than `db:push`.
  const vector = await db.execute<{ column_name: string }>(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contact_embeddings'
      AND column_name = 'embedding_vector'
  `);
  console.log(
    rowsOf<unknown>(vector).length > 0
      ? "  ok contact_embeddings.embedding_vector still present"
      : "  NOTE contact_embeddings.embedding_vector absent (created at runtime)"
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
