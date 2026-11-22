/**
 * contacts.sort_key sorts a name with a maiden name in parentheses by the real surname, and the
 * sweep upgrades a database that still has the old expression.
 * Run: npx tsx scripts/smoke-contacts-sort-key.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, reconcileSchema, rowsOf, SCHEMA_VERSION } from "../src/db";
import { checker } from "./smoke/check";

const t = checker();
const USER = "smoke-sort-key";

run(async () => {
  const db = await getDb();
  const keyOf = async (fullName: string) => {
    await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
    await db.execute(sql`INSERT INTO contacts (user_id, full_name) VALUES (${USER}, ${fullName})`);
    return rowsOf<{ sort_key: string }>(await db.execute(sql`SELECT sort_key FROM contacts WHERE user_id = ${USER}`))[0]?.sort_key;
  };
  t.check("maiden name in parentheses is ignored (M)", (await keyOf("Briana (Simmons) Medley"))?.startsWith("m") === true);
  t.check("maiden name in parentheses is ignored (W)", (await keyOf("Kailee (Zeltner) Webb"))?.startsWith("w") === true);
  t.check("a plain name still sorts by its last word", (await keyOf("Ada Lovelace")) === "lovelace");
  t.check("a name that is only parentheses falls back to the raw last word", (await keyOf("(Prince)")) === "(prince)");

  // A database stamped with the old expression is rewritten by the sweep.
  await db.execute(sql`DROP INDEX IF EXISTS contacts_user_sort_idx`);
  await db.execute(sql`ALTER TABLE contacts DROP COLUMN sort_key`);
  await db.execute(sql`ALTER TABLE contacts ADD COLUMN sort_key text GENERATED ALWAYS AS (lower(coalesce(nullif(trim(last_name), ''), split_part(trim(full_name), ' ', -1)))) STORED`);
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1} WHERE id = 1`);
  await reconcileSchema();
  t.check("the sweep replaces the old expression", (await keyOf("Briana (Simmons) Medley"))?.startsWith("m") === true);
  const idx = rowsOf(await db.execute(sql`SELECT 1 FROM pg_indexes WHERE indexname = 'contacts_user_sort_idx'`));
  t.check("and rebuilds the sort index", idx.length === 1);

  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  t.done("smoke-contacts-sort-key");
});
