/**
 * The linkedin_slug generated column is dropped and re-added only when its stored
 * expression is not the one SCALE_DDL declares. Dropping rewrote all of `contacts` under an
 * exclusive lock on every version bump. `attnum` is the tell: a drop-and-add gives the
 * column a new one.
 *
 * Run: npx tsx scripts/smoke-linkedin-slug-guard.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import {
  DROP_LINKEDIN_SLUG_STATEMENT, LINKEDIN_SLUG_EXPRESSION, SCALE_DDL, SCHEMA_VERSION,
  getDb, linkedinSlugNeedsRewrite, normalizeGeneratedExpression, reconcileSchema, rowsOf,
} from "../src/db";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const USER = "smoke-slug-guard";

async function slugColumn(): Promise<{ attnum: number; expr: string } | undefined> {
  const db = await getDb();
  return rowsOf<{ attnum: number; expr: string }>(await db.execute(sql`
    SELECT a.attnum, pg_get_expr(d.adbin, d.adrelid) AS expr
      FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'contacts'::regclass AND a.attname = 'linkedin_slug' AND NOT a.attisdropped`))[0];
}

async function forceSweep() {
  const db = await getDb();
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1} WHERE id = 1`);
  return reconcileSchema();
}

run(async () => {
  console.log("The guard's own invariants...");
  check("SCALE_DDL still carries the exact DROP the guard filters", SCALE_DDL.includes(DROP_LINKEDIN_SLUG_STATEMENT));
  const add = SCALE_DDL.find((s) => s.includes("ADD COLUMN IF NOT EXISTS linkedin_slug")) ?? "";
  check("SCALE_DDL's ADD uses LINKEDIN_SLUG_EXPRESSION",
    normalizeGeneratedExpression(add).includes(normalizeGeneratedExpression(LINKEDIN_SLUG_EXPRESSION)));
  check("no column means nothing to rewrite", linkedinSlugNeedsRewrite(null) === false);

  console.log("\nA sweep over a current column leaves it alone...");
  const before = await slugColumn();
  check("the stored expression reads as current", Boolean(before) && !linkedinSlugNeedsRewrite(before!.expr), before?.expr);
  const swept = await forceSweep();
  check("the sweep ran cleanly", swept.applied === true && swept.failed.length === 0, JSON.stringify(swept));
  const after = await slugColumn();
  check("the column was not dropped and re-added (attnum unchanged)", after?.attnum === before?.attnum,
    `${before?.attnum} → ${after?.attnum}`);

  console.log("\nA column carrying the old expression is rewritten...");
  const db = await getDb();
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  await db.execute(sql.raw(DROP_LINKEDIN_SLUG_STATEMENT));
  // The earlier revision: stops at the first "/" only, so a query string stays on the slug.
  await db.execute(sql.raw(`ALTER TABLE contacts ADD COLUMN linkedin_slug text GENERATED ALWAYS AS (
    lower(nullif(split_part(split_part(coalesce(linkedin_url, ''), '/in/', 2), '/', 1), ''))) STORED`));
  await db.execute(sql`INSERT INTO contacts (user_id, full_name, linkedin_url)
    VALUES (${USER}, 'Ada Query', 'https://www.linkedin.com/in/ada?trk=feed')`);
  const old = await slugColumn();
  check("fixture: the old expression reads as stale", Boolean(old) && linkedinSlugNeedsRewrite(old!.expr), old?.expr);
  const rewrite = await forceSweep();
  check("the sweep ran cleanly", rewrite.applied === true && rewrite.failed.length === 0, JSON.stringify(rewrite));
  const fixed = await slugColumn();
  check("the column now carries the current expression", Boolean(fixed) && !linkedinSlugNeedsRewrite(fixed!.expr), fixed?.expr);
  const slug = rowsOf<{ linkedin_slug: string | null }>(
    await db.execute(sql`SELECT linkedin_slug FROM contacts WHERE user_id = ${USER}`))[0]?.linkedin_slug;
  check("existing rows are recomputed with the query string stripped", slug === "ada", String(slug));
  check("the slug index is back",
    rowsOf(await db.execute(sql`SELECT 1 FROM pg_indexes WHERE indexname = 'contacts_slug_idx'`)).length === 1);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll linkedin-slug guard checks passed.");
});
