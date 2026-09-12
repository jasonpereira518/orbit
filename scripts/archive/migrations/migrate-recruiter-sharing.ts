/**
 * Adds the recruiter sharing opt-in and the private per-link scan fields.
 *
 * Additive and idempotent — safe to re-run. Never use `npm run db:push` for this:
 * drizzle push drops the runtime-managed contact_embeddings.embedding_vector column
 * and its HNSW index, which would destroy semantic search.
 *
 * Deliberately no backfill. `recruiter_sharing` defaults to 0 for every existing
 * account: the `recruiters` table was globally readable before any consent mechanism
 * existed, so the only defensible migration is to empty the pool and let it refill by
 * explicit opt-in. No rows are deleted — they just stop being visible to strangers.
 *
 * Run: npx tsx scripts/migrate-recruiter-sharing.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../../../src/db";
import { sql } from "drizzle-orm";

const STATEMENTS = [
  sql`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS recruiter_sharing integer NOT NULL DEFAULT 0`,
  sql`ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS shared_to_pool integer NOT NULL DEFAULT 1`,
  sql`ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS ai_summary text`,
  sql`ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS companies_mentioned jsonb DEFAULT '[]'`,
  sql`ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS roles_discussed jsonb DEFAULT '[]'`,
  sql`ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS first_email_at timestamptz`,
  sql`ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS last_email_at timestamptz`,
  sql`ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS email_count integer NOT NULL DEFAULT 0`,
  sql`ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS gmail_thread_id text`,
];

async function main() {
  const db = await getDb();

  for (const statement of STATEMENTS) {
    await db.execute(statement);
  }
  console.log(`applied ${STATEMENTS.length} additive column statements`);

  // The whole reason this file exists instead of a push: prove the runtime-managed
  // pgvector column is still there afterwards.
  //
  // Neon only. `migratePgvector` in src/db/index.ts is called from `migrateNeon` and
  // nowhere else, so a local PGlite dev DB has never had this column and asserting on
  // it there is a guaranteed false alarm.
  if (process.env.DATABASE_URL?.trim()) {
    const check = await db.execute(
      sql`SELECT column_name FROM information_schema.columns
          WHERE table_name = 'contact_embeddings' AND column_name = 'embedding_vector'`
    );
    const rows = "rows" in check ? check.rows : check;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(
        "contact_embeddings.embedding_vector is missing — semantic search would be broken. Did something run drizzle push?"
      );
    }
    console.log("verified embedding_vector survived");
  } else {
    console.log("PGlite backend — skipping pgvector check (never present locally)");
  }

  const sharing = await db.execute(
    sql`SELECT count(*)::int AS n FROM user_settings WHERE recruiter_sharing = 1`
  );
  const sharingRows = "rows" in sharing ? sharing.rows : sharing;
  const n = Array.isArray(sharingRows) ? (sharingRows[0] as { n: number })?.n : 0;
  console.log(`users currently sharing: ${n} (expected 0 on first run)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
