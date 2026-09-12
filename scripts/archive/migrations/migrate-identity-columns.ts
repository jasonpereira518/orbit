/**
 * Adds the Clerk identity mirror columns to `user_settings`, and drops the retired
 * `admin_reveal_grants` table.
 *
 * Uses DATABASE_URL (Neon) when set, otherwise local PGlite.
 *
 * Deliberately NOT `drizzle-kit push`: push is destructive against the real database
 * because `contact_embeddings.embedding_vector` is created at runtime by the pgvector
 * bootstrap in `src/db/index.ts` and is absent from `schema.ts`, so push proposes
 * dropping it. Targeted, additive DDL only.
 *
 * The one DROP here is deliberate and safe: `admin_reveal_grants` held operator viewing
 * grants and no user data, and the feature it backed is gone. Leaving the table behind
 * would be worse than dropping it — `scripts/smoke-purge.ts` derives its coverage list
 * from `schema.ts`, so an orphan table is one the purge test silently stops checking.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { sql } from "drizzle-orm";
import { getDb } from "../../../src/db";

const COLUMNS: Array<[column: string, definition: string]> = [
  ["first_name", "text"],
  ["last_name", "text"],
  ["profile_image_url", "text"],
];

/** Both drivers disagree on the result shape; normalise before reading. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: unknown[] }).rows ?? []) as T[];
}

async function main() {
  const mode = process.env.DATABASE_URL?.trim() ? "neon" : "pglite";
  console.log(`Adding Clerk identity columns to user_settings (${mode})…`);

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
  const have = new Set(
    rowsOf<{ column_name: string }>(present).map((r) => r.column_name)
  );
  const missing = COLUMNS.map(([c]) => c).filter((c) => !have.has(c));

  if (missing.length > 0) {
    throw new Error(`Columns still missing after migration: ${missing.join(", ")}`);
  }

  await db.execute(sql.raw(`DROP TABLE IF EXISTS admin_reveal_grants`));
  console.log("  ok dropped admin_reveal_grants (reveal gate removed)");

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
