/**
 * Creates recruiter_messages — the ledger of AI-drafted emails sent to recruiters
 * through the user's own Gmail.
 *
 * Additive and idempotent. Never use `npm run db:push`: push drops the runtime-managed
 * contact_embeddings.embedding_vector column and its HNSW index.
 *
 * Run: npx tsx scripts/migrate-recruiter-messages.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS recruiter_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      recruiter_id uuid NOT NULL REFERENCES recruiters(id) ON DELETE CASCADE,
      intent text NOT NULL,
      subject text NOT NULL,
      body text NOT NULL,
      status text NOT NULL DEFAULT 'draft',
      gmail_message_id text,
      gmail_thread_id text,
      sent_at timestamptz,
      error_message text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS recruiter_messages_user_idx ON recruiter_messages(user_id, status)`
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS recruiter_messages_recruiter_idx ON recruiter_messages(recruiter_id)`
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS recruiter_messages_sent_idx ON recruiter_messages(user_id, sent_at)`
  );
  console.log("recruiter_messages ready");

  // Neon only — `migratePgvector` runs from `migrateNeon` and nowhere else, so a local
  // PGlite DB has never had this column and asserting on it there always fails.
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
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
