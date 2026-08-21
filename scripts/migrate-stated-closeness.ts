/**
 * Adds contacts.stated_closeness and backfills it from relationship_score.
 *
 * Idempotent — safe to re-run. Never use `npm run db:push` for this: drizzle
 * push drops the runtime-managed embedding_vector column.
 *
 * Run: npx tsx scripts/migrate-stated-closeness.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  await db.execute(
    sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS stated_closeness integer`
  );
  console.log("column stated_closeness ready");

  // A value other than the default of 2 is the only evidence we have that a
  // human moved the slider. Contacts sitting at exactly 2 are treated as
  // unrated; a user who deliberately rated someone a 2 simply sees them
  // become triage-eligible, which is a benign failure.
  const result = await db.execute(
    sql`UPDATE contacts
        SET stated_closeness = relationship_score
        WHERE stated_closeness IS NULL AND relationship_score <> 2`
  );
  console.log("backfilled rows:", result.rowCount ?? 0);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
