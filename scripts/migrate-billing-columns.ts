/**
 * Adds the billing columns used by `src/lib/entitlements.ts` to `user_settings`.
 * Uses DATABASE_URL (Neon) when set, otherwise local PGlite.
 *
 * Deliberately NOT `drizzle-kit push`: push is destructive against the real database
 * because `contact_embeddings.embedding_vector` is created at runtime by the pgvector
 * bootstrap in `src/db/index.ts` and is absent from `schema.ts`, so push proposes
 * dropping it. Targeted, additive DDL only.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { sql } from "drizzle-orm";
import { getDb } from "../src/db";

const COLUMNS: Array<[column: string, definition: string]> = [
  ["comped_plan", "text"],
  ["lifetime_purchased_at", "timestamptz"],
  ["stripe_customer_id", "text"],
  ["subscription_plan", "text"],
  ["subscription_status", "text"],
  ["subscription_period_end", "timestamptz"],
];

async function main() {
  const mode = process.env.DATABASE_URL?.trim() ? "neon" : "pglite";
  console.log(`Adding billing columns to user_settings (${mode})…`);

  const db = await getDb();

  for (const [column, definition] of COLUMNS) {
    await db.execute(
      sql.raw(
        `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ${column} ${definition}`
      )
    );
    console.log("  ok", column);
  }

  const present = await db.execute<{ column_name: string }>(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_settings'
    ORDER BY ordinal_position
  `);
  const names = (
    Array.isArray(present) ? present : (present as { rows?: unknown[] }).rows ?? []
  ) as Array<{ column_name: string }>;
  const have = new Set(names.map((r) => r.column_name));
  const missing = COLUMNS.map(([c]) => c).filter((c) => !have.has(c));

  if (missing.length > 0) {
    throw new Error(`Columns still missing after migration: ${missing.join(", ")}`);
  }

  // The whole reason this script exists rather than `db:push`.
  const vector = await db.execute<{ column_name: string }>(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'contact_embeddings'
      AND column_name = 'embedding_vector'
  `);
  const vectorRows = (
    Array.isArray(vector) ? vector : (vector as { rows?: unknown[] }).rows ?? []
  ) as unknown[];
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
