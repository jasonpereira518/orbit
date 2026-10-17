/**
 * contacts.search_tsv and the contacts_name_trgm index are rebuilt only when they differ
 * from what SCALE_DDL declares. Dropping and re-adding search_tsv rewrote all of `contacts`
 * under an exclusive lock on every version bump, left live search without the column until
 * the ADD landed, and, with a statement_timeout on the role, could leave it gone for good
 * (reliability/tests/migration-under-load.sh). `attnum` and the index oid are the tell: a
 * rebuild gives them new values.
 *
 * Run: npx tsx scripts/smoke-search-tsv-guard.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import {
  DROP_SEARCH_TSV_STATEMENT, SCALE_DDL, SCHEMA_VERSION, declaredSearchTsvExpression,
  generatedExpressionsMatch, getDb, nameTrgmIndexIsCurrent, reconcileSchema, rowsOf,
} from "../src/db";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const USER = "smoke-tsv-guard";

async function tsvColumn(): Promise<{ attnum: number; expr: string } | undefined> {
  const db = await getDb();
  return rowsOf<{ attnum: number; expr: string }>(await db.execute(sql`
    SELECT a.attnum, pg_get_expr(d.adbin, d.adrelid) AS expr
      FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'contacts'::regclass AND a.attname = 'search_tsv' AND NOT a.attisdropped`))[0];
}

async function trgmIndex(): Promise<{ oid: number; def: string } | undefined> {
  const db = await getDb();
  return rowsOf<{ oid: number; def: string }>(await db.execute(sql`
    SELECT 'contacts_name_trgm'::regclass::oid::int AS oid, pg_get_indexdef('contacts_name_trgm'::regclass) AS def
     WHERE to_regclass('public.contacts_name_trgm') IS NOT NULL`))[0];
}

async function forceSweep() {
  const db = await getDb();
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1} WHERE id = 1`);
  return reconcileSchema();
}

run(async () => {
  const db = await getDb();

  console.log("The guard's own invariants...");
  const declared = declaredSearchTsvExpression();
  check("SCALE_DDL still carries the exact DROP the guard filters", SCALE_DDL.includes(DROP_SEARCH_TSV_STATEMENT));
  check("the declared expression is readable from the ADD statement", declared !== null && declared.includes("setweight"));
  check("a casted, re-parenthesised rendering matches",
    generatedExpressionsMatch("((coalesce(a, ''::text) || ' '::text))", "coalesce(a,'') || ' '"));
  check("a changed weight does not match",
    !generatedExpressionsMatch("setweight(x, 'D'::\"char\")", "setweight(x, 'C')"));
  check("the trigram shape check accepts the declared index",
    nameTrgmIndexIsCurrent("CREATE INDEX contacts_name_trgm ON public.contacts USING gin (lower(full_name) gin_trgm_ops, lower(COALESCE(company, ''::text)) gin_trgm_ops)"));
  check("the trigram shape check rejects the old raw-column index",
    !nameTrgmIndexIsCurrent("CREATE INDEX contacts_name_trgm ON public.contacts USING gin (full_name gin_trgm_ops, company gin_trgm_ops)"));

  console.log("\nA sweep over current objects leaves them alone...");
  const colBefore = await tsvColumn();
  const idxBefore = await trgmIndex();
  check("the stored expression reads as current",
    Boolean(colBefore) && generatedExpressionsMatch(colBefore!.expr, declared ?? ""), colBefore?.expr);
  const swept = await forceSweep();
  check("the sweep ran cleanly", swept.applied === true && swept.failed.length === 0, JSON.stringify(swept));
  const colAfter = await tsvColumn();
  check("search_tsv was not dropped and re-added (attnum unchanged)", colAfter?.attnum === colBefore?.attnum,
    `${colBefore?.attnum} → ${colAfter?.attnum}`);
  const idxAfter = await trgmIndex();
  if (idxBefore) {
    check("contacts_name_trgm was not rebuilt (oid unchanged)", idxAfter?.oid === idxBefore.oid,
      `${idxBefore.oid} → ${idxAfter?.oid}`);
  }

  console.log("\nA column carrying an old expression is rewritten...");
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  await db.execute(sql.raw(DROP_SEARCH_TSV_STATEMENT));
  await db.execute(sql.raw(`ALTER TABLE contacts ADD COLUMN search_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', coalesce(full_name, ''))) STORED`));
  const old = await tsvColumn();
  check("fixture: the old expression reads as stale",
    Boolean(old) && !generatedExpressionsMatch(old!.expr, declared ?? ""), old?.expr);
  const rewrite = await forceSweep();
  check("the sweep ran cleanly", rewrite.applied === true && rewrite.failed.length === 0, JSON.stringify(rewrite));
  const fixed = await tsvColumn();
  check("the column now carries the current expression",
    Boolean(fixed) && generatedExpressionsMatch(fixed!.expr, declared ?? ""), fixed?.expr);
  check("its GIN index is back",
    rowsOf(await db.execute(sql`SELECT 1 FROM pg_indexes WHERE indexname = 'contacts_search_gin'`)).length === 1);

  console.log("\nA missing or wrong trigram index is repaired...");
  await db.execute(sql`DROP INDEX IF EXISTS contacts_name_trgm`);
  const repaired = await forceSweep();
  check("the sweep ran cleanly", repaired.applied === true && repaired.failed.length === 0, JSON.stringify(repaired));
  const idx = await trgmIndex();
  check("the index is back and current", Boolean(idx) && nameTrgmIndexIsCurrent(idx!.def), idx?.def);

  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll search_tsv guard checks passed.");
});
