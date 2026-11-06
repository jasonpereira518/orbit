/**
 * Fill `contacts.school` from education entries Orbit already found.
 *
 * Web research (`work-history-research.ts`) has always stored a contact's schools in
 * `contact_experiences`, but until it learned to copy the latest one onto the contact, the
 * row's own `school` stayed empty — so chat, the Contacts School filter and "same school"
 * never saw it. New research fills it as it goes; this catches up on what is already stored.
 *
 * Only empty schools are filled, from the most recent education entry (latest end year, then
 * the captured page order). Re-running it is a no-op.
 *
 * Targets whatever DATABASE_URL says — the real database, like migrate.ts, not a smoke
 * fixture. Run: npx tsx scripts/backfill-school-from-experiences.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { sql } from "drizzle-orm";
import { closeDb, getDb, rowsOf } from "../src/db";

async function main() {
  const target = process.env.DATABASE_URL?.trim() ? "DATABASE_URL" : "local PGlite";
  console.log(`backfill: filling contacts.school from education entries on ${target}…`);

  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE contacts c
    SET school = e.organization, updated_at = now()
    FROM (
      SELECT DISTINCT ON (contact_id) contact_id, user_id, organization
      FROM contact_experiences
      WHERE kind = 'education' AND btrim(organization) <> ''
      ORDER BY contact_id, end_year DESC NULLS FIRST, sort_index ASC
    ) e
    WHERE c.id = e.contact_id
      AND c.user_id = e.user_id
      AND (c.school IS NULL OR btrim(c.school) = '')
    RETURNING c.id
  `);
  console.log(`backfill: ${rowsOf<{ id: string }>(result).length} contact(s) got a school.`);
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
