/**
 * Adds the four data streams the admin console needs to answer startup questions, plus the
 * acquisition columns on `user_settings`.
 *
 *   feedback        what users said, unaggregated
 *   billing_events  what each billing webhook meant financially
 *   infra_costs     what Orbit pays, one row per provider per month
 *   gate_events     every time a plan gate refused someone
 *
 * Uses DATABASE_URL (Neon) when set, otherwise local PGlite.
 *
 * Deliberately NOT `drizzle-kit push`: push is destructive against the real database
 * because `contact_embeddings.embedding_vector` is created at runtime by the pgvector
 * bootstrap in `src/db/index.ts` and is absent from `schema.ts`, so push proposes
 * dropping it. Targeted, additive DDL only.
 *
 * Run this BEFORE the console screens that read these tables. They only accumulate history
 * from the moment they exist, so every day of delay is a day of data that cannot be
 * recovered later.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { sql } from "drizzle-orm";
import { getDb } from "../../../src/db";

const COLUMNS: Array<[column: string, definition: string]> = [
  ["signup_referrer", "text"],
  ["signup_utm_source", "text"],
  ["signup_utm_medium", "text"],
  ["signup_utm_campaign", "text"],
  ["signup_landing_path", "text"],
  ["signup_attributed_at", "timestamptz"],
];

const TABLES = [
  `CREATE TABLE IF NOT EXISTS feedback (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id text NOT NULL,
     kind text NOT NULL,
     score integer,
     text text,
     context jsonb NOT NULL DEFAULT '{}',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS feedback_kind_created_idx ON feedback(kind, created_at)`,
  `CREATE INDEX IF NOT EXISTS feedback_user_created_idx ON feedback(user_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS billing_events (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     source text NOT NULL,
     event_id text NOT NULL,
     kind text NOT NULL,
     user_id text,
     amount_cents integer NOT NULL DEFAULT 0,
     mrr_delta_cents integer NOT NULL DEFAULT 0,
     effective_at timestamptz NOT NULL,
     detail jsonb NOT NULL DEFAULT '{}',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  // Unique, unlike `webhook_deliveries` — a redelivery here would double-count money.
  `CREATE UNIQUE INDEX IF NOT EXISTS billing_events_source_event_uidx ON billing_events(source, event_id)`,
  `CREATE INDEX IF NOT EXISTS billing_events_effective_idx ON billing_events(effective_at)`,
  `CREATE INDEX IF NOT EXISTS billing_events_user_effective_idx ON billing_events(user_id, effective_at)`,
  `CREATE INDEX IF NOT EXISTS billing_events_kind_effective_idx ON billing_events(kind, effective_at)`,

  `CREATE TABLE IF NOT EXISTS infra_costs (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     provider text NOT NULL,
     period_month timestamptz NOT NULL,
     amount_cents integer NOT NULL,
     note text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS infra_costs_provider_month_uidx ON infra_costs(provider, period_month)`,
  `CREATE INDEX IF NOT EXISTS infra_costs_month_idx ON infra_costs(period_month)`,

  `CREATE TABLE IF NOT EXISTS gate_events (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id text NOT NULL,
     feature text NOT NULL,
     plan text NOT NULL,
     context jsonb NOT NULL DEFAULT '{}',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS gate_events_feature_created_idx ON gate_events(feature, created_at)`,
  `CREATE INDEX IF NOT EXISTS gate_events_user_created_idx ON gate_events(user_id, created_at)`,
];

const EXPECTED_TABLES = ["feedback", "billing_events", "infra_costs", "gate_events"];

/** Both drivers disagree on the result shape; normalise before reading. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: unknown[] }).rows ?? []) as T[];
}

async function main() {
  const mode = process.env.DATABASE_URL?.trim() ? "neon" : "pglite";
  console.log(`Adding startup instrumentation (${mode})…`);

  const db = await getDb();

  for (const [column, definition] of COLUMNS) {
    await db.execute(
      sql.raw(
        `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ${column} ${definition}`
      )
    );
    console.log("  ok  user_settings.%s", column);
  }

  for (const statement of TABLES) {
    await db.execute(sql.raw(statement));
  }
  console.log(`  ok  ${EXPECTED_TABLES.length} tables and their indexes`);

  /* ------------------------------------------------------------------------ assertions */

  const cols = await db.execute<{ column_name: string }>(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_settings'
  `);
  const have = new Set(
    rowsOf<{ column_name: string }>(cols).map((r) => r.column_name)
  );
  const missingCols = COLUMNS.map(([c]) => c).filter((c) => !have.has(c));
  if (missingCols.length > 0) {
    throw new Error(`Columns still missing: ${missingCols.join(", ")}`);
  }

  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `);
  const haveTables = new Set(
    rowsOf<{ table_name: string }>(tables).map((r) => r.table_name)
  );
  const missingTables = EXPECTED_TABLES.filter((t) => !haveTables.has(t));
  if (missingTables.length > 0) {
    throw new Error(`Tables still missing: ${missingTables.join(", ")}`);
  }

  // The uniqueness that stops a redelivered webhook from being counted as revenue twice.
  // Asserted rather than assumed, because losing it is silent and the symptom is inflated
  // MRR that nobody questions.
  const idx = await db.execute<{ indexname: string }>(sql`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'billing_events'
  `);
  const haveIdx = new Set(rowsOf<{ indexname: string }>(idx).map((r) => r.indexname));
  if (!haveIdx.has("billing_events_source_event_uidx")) {
    throw new Error(
      "billing_events is missing its unique (source, event_id) index — a redelivered webhook would double-count revenue."
    );
  }
  console.log("  ok  billing_events cannot double-count a redelivered event");

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
      ? "  ok  contact_embeddings.embedding_vector still present"
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
