/**
 * Adds contacts.embedding_stale_at and the uniqueness the embedding backfill upserts on.
 *
 * Idempotent — safe to re-run. Never use `npm run db:push` for this: drizzle push drops
 * the runtime-managed embedding_vector column.
 *
 * Run: npx tsx scripts/migrate-embedding-stale.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { sql } from "drizzle-orm";
import { getDb } from "../src/db";

async function main() {
  const db = await getDb();

  await db.execute(
    sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS embedding_stale_at timestamptz`
  );
  console.log("column embedding_stale_at ready");

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS contacts_embedding_stale_idx
    ON contacts(user_id) WHERE embedding_stale_at IS NOT NULL
  `);
  console.log("partial index contacts_embedding_stale_idx ready");

  // The unique index below cannot be created while duplicates exist, and duplicates are
  // possible: nothing has ever enforced this key. Keep the newest row per key — it is the
  // one readers would have found anyway, since `findFirst` has no ORDER BY and the newest
  // row is what the last write produced.
  const dedupeResult = await db.execute(sql`
    DELETE FROM contact_embeddings a
    USING contact_embeddings b
    WHERE a.user_id = b.user_id
      AND a.contact_id = b.contact_id
      AND a.source_type = b.source_type
      AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id))
  `);
  // `db.execute()` returns a union of PGlite's `Results` and Neon's `NeonHttpQueryResult`.
  // Only the Neon shape has `rowCount`; PGlite reports the same thing under
  // `affectedRows` instead. Narrow on the property's presence rather than casting, so both
  // backends report a real count.
  const deletedRows =
    "rowCount" in dedupeResult
      ? dedupeResult.rowCount
      : (dedupeResult.affectedRows ?? 0);
  console.log("deduped contact_embeddings, rows deleted:", deletedRows);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS embeddings_user_contact_source_uidx
    ON contact_embeddings(user_id, contact_id, source_type)
  `);
  console.log("unique index embeddings_user_contact_source_uidx ready");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  });
