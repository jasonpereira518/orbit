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

// Mirrors the `contacts.relationship_score` schema default (see
// `src/db/schema.ts`). A row still sitting at exactly this value is the only
// signal we have that nobody ever rated it — the backfill treats it as
// "never rated" rather than "deliberately rated 2".
const IMPORT_DEFAULT_RELATIONSHIP_SCORE = 2;

async function main() {
  const db = await getDb();

  await db.execute(
    sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS stated_closeness integer`
  );
  console.log("column stated_closeness ready");

  // A value other than the default is the only evidence we have that a
  // human moved the slider. Contacts sitting at exactly the default are
  // treated as unrated; a user who deliberately rated someone a 2 simply
  // sees them become triage-eligible, which is a benign failure.
  const result = await db.execute(
    sql`UPDATE contacts
        SET stated_closeness = relationship_score
        WHERE stated_closeness IS NULL
          AND relationship_score <> ${IMPORT_DEFAULT_RELATIONSHIP_SCORE}`
  );
  console.log("backfilled rows:", result.rowCount ?? 0);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
