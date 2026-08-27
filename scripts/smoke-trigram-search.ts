/**
 * Asserts the trigram index matches the lower()-wrapped predicates and that a typo'd
 * name still matches via the % operator. Stop dev servers on .data/pglite first.
 * Run: npx tsx scripts/smoke-trigram-search.ts
 */
import { getDb, isTrigramAvailable, rowsOf } from "../src/db";
import { contacts } from "../src/db/schema";
import { sql, eq } from "drizzle-orm";

const EVAL_USER = "smoke-trigram-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  if (process.env.DATABASE_URL) throw new Error("Unset DATABASE_URL — local PGlite only.");
  const db = await getDb();
  check("isTrigramAvailable() is true", isTrigramAvailable());

  const idx = rowsOf<{ indexdef: string }>(
    await db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'contacts' AND indexname = 'contacts_name_trgm'`)
  );
  check("contacts_name_trgm exists", idx.length === 1);
  // Two separate assertions, not one substring test: a regression that lowers only one
  // column (e.g. reverting `company` to a raw expression) must fail here, not slip through
  // because "lower(" still appears somewhere else in the indexdef.
  check(
    "index lowers full_name",
    /lower\(\(?full_name\)?(::text)?\)/.test(idx[0].indexdef),
    idx[0]?.indexdef
  );
  check(
    "index lowers company",
    /lower\(\(?coalesce\(company,\s*''(::text)?\)\)?(::text)?\)/i.test(idx[0].indexdef),
    idx[0]?.indexdef
  );

  await db.delete(contacts).where(eq(contacts.userId, EVAL_USER));
  await db.insert(contacts).values({
    userId: EVAL_USER,
    fullName: "Katherine Mannington",
    company: "Braddock Capital",
  });

  // typo: "Katherin Manington"
  const hit = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT id FROM contacts
      WHERE user_id = ${EVAL_USER}
        AND (lower(full_name) % ${"katherin manington"} OR lower(coalesce(company, '')) % ${"katherin manington"})`)
  );
  check("typo'd name matches via % operator", hit.length === 1);

  await db.delete(contacts).where(eq(contacts.userId, EVAL_USER));
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
