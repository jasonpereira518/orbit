/**
 * Scalability phase 2 (SCHEMA_VERSION 112): the migration sweep stops rewriting big tables
 * it has no reason to touch, every foreign key has an index leading with it, and
 * `interactions.memory_dirty` narrows the passage sweep without losing work.
 *
 * - `contacts.search_tsv` used to be dropped and re-added on EVERY version bump, which
 *   rewrote every user's contacts under an exclusive lock. `contacts_name_trgm` was dropped
 *   and rebuilt too. `attnum` and the index oid are the tells: a rewrite changes both.
 * - A foreign key is checked with a bare `WHERE fk = $1` on each parent delete, so an FK
 *   with no index leading with it made every contact or interaction delete a cross-tenant scan.
 * - The trigger must mark exactly the writes that can change a note's passages.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-scale-sweep-guards.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import {
  CONTACTS_SEARCH_TSV_EXPRESSION, DROP_CONTACTS_SEARCH_TSV_STATEMENT, SCALE_DDL, SCHEMA_VERSION,
  generatedExpressionDiffers, getDb, normalizeGeneratedExpression, reconcileSchema, rowsOf,
} from "../src/db";
import { backfillMemoryChunks, usersWithPendingMemoryWork } from "../src/lib/memory-backfill";
import { concurrentIndexStatements, metadataOnlyColumnAdds } from "./lib/concurrent-indexes";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const USER = "smoke-sweep-guards";

async function tsvColumn() {
  const db = await getDb();
  return rowsOf<{ attnum: number; expr: string }>(await db.execute(sql`
    SELECT a.attnum, pg_get_expr(d.adbin, d.adrelid) AS expr
      FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'contacts'::regclass AND a.attname = 'search_tsv' AND NOT a.attisdropped`))[0];
}

async function indexOid(name: string) {
  const db = await getDb();
  return rowsOf<{ oid: number }>(await db.execute(sql`SELECT c.oid::int AS oid FROM pg_class c WHERE c.relname = ${name}`))[0]?.oid;
}

async function forceSweep() {
  const db = await getDb();
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1} WHERE id = 1`);
  return reconcileSchema();
}

run(async () => {
  const db = await getDb();

  console.log("The guard's own invariants...");
  check("SCALE_DDL still carries the exact DROP the guard filters", SCALE_DDL.includes(DROP_CONTACTS_SEARCH_TSV_STATEMENT));
  const add = SCALE_DDL.find((s) => s.includes("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS search_tsv")) ?? "";
  check("SCALE_DDL's ADD uses CONTACTS_SEARCH_TSV_EXPRESSION",
    normalizeGeneratedExpression(add).includes(normalizeGeneratedExpression(CONTACTS_SEARCH_TSV_EXPRESSION)));
  check("the legacy action-items backfill is out of the sweep", !SCALE_DDL.some((s) => /INSERT INTO action_items/i.test(s)));

  console.log("\nA sweep over a current schema leaves the big contacts structures alone...");
  const before = await tsvColumn();
  check("the stored search_tsv reads as current (casts and all)", Boolean(before) && !generatedExpressionDiffers(before!.expr, CONTACTS_SEARCH_TSV_EXPRESSION), before?.expr);
  const trgmBefore = await indexOid("contacts_name_trgm");
  const swept = await forceSweep();
  check("the sweep ran cleanly", swept.applied === true && swept.failed.length === 0, JSON.stringify(swept.failed));
  check("search_tsv was not dropped and re-added (attnum unchanged)", (await tsvColumn())?.attnum === before?.attnum);
  check("contacts_name_trgm was not rebuilt (oid unchanged)", trgmBefore !== undefined && (await indexOid("contacts_name_trgm")) === trgmBefore);

  console.log("\nA stale search_tsv is still rewritten...");
  await db.execute(sql.raw(DROP_CONTACTS_SEARCH_TSV_STATEMENT));
  await db.execute(sql.raw(`ALTER TABLE contacts ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(full_name, ''))) STORED`));
  check("fixture: the old expression reads as stale", generatedExpressionDiffers((await tsvColumn())!.expr, CONTACTS_SEARCH_TSV_EXPRESSION));
  const rewrite = await forceSweep();
  check("the sweep ran cleanly", rewrite.applied === true && rewrite.failed.length === 0, JSON.stringify(rewrite.failed));
  check("and the column carries the declared expression again", !generatedExpressionDiffers((await tsvColumn())!.expr, CONTACTS_SEARCH_TSV_EXPRESSION));
  check("with its GIN index back", Boolean(await indexOid("contacts_search_gin")));

  console.log("\nEvery foreign key has an index leading with it...");
  const unindexed = rowsOf<{ fk: string }>(await db.execute(sql`
    SELECT c.conrelid::regclass::text || '.' || a.attname AS fk
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])`));
  check("no FK column is left without one", unindexed.length === 0, unindexed.map((r) => r.fk).join(", "));

  console.log("\nmemory_dirty follows the writes that can change a note's passages...");
  await db.execute(sql`DELETE FROM interactions WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  const [contact] = rowsOf<{ id: string }>(await db.execute(sql`INSERT INTO contacts (user_id, full_name) VALUES (${USER}, 'Ada Lovelace') RETURNING id`));
  const [note] = rowsOf<{ id: string }>(await db.execute(sql`
    INSERT INTO interactions (user_id, contact_id, raw_notes, interaction_type, memory_dirty)
    VALUES (${USER}, ${contact!.id}, 'Talked about the analytical engine and her next paper.', 'note', false) RETURNING id`));
  const dirty = async () => rowsOf<{ memory_dirty: boolean }>(await db.execute(sql`SELECT memory_dirty FROM interactions WHERE id = ${note!.id}`))[0]!.memory_dirty;
  check("an insert is marked, whatever the writer said", await dirty());
  check("so the hourly finder sees the user", (await usersWithPendingMemoryWork(1000, async () => false)).includes(USER));
  const first = await backfillMemoryChunks(USER);
  check("the per-user pass indexes the note", first.indexed === 1 && first.remaining === 0, JSON.stringify(first));
  check("and clears the flag once its passages match", (await dirty()) === false);
  check("so the finder no longer lists the user for notes", !(await usersWithPendingMemoryWork(1000, async () => false)).includes(USER));
  await db.execute(sql`UPDATE interactions SET sentiment = 'positive' WHERE id = ${note!.id}`);
  check("an update to a column passages never read leaves it clean", (await dirty()) === false);
  await db.execute(sql`UPDATE interactions SET raw_notes = 'Talked about Bernoulli numbers instead.' WHERE id = ${note!.id}`);
  check("an edit to the note's text marks it", await dirty());
  const second = await backfillMemoryChunks(USER);
  check("and the next pass re-indexes it and clears it", second.indexed === 1 && (await dirty()) === false, JSON.stringify(second));
  await db.execute(sql`UPDATE interactions SET memory_dirty = true WHERE id = ${note!.id}`);
  const settled = await backfillMemoryChunks(USER);
  check("a dirty row whose passages already match is cleared without re-indexing", settled.indexed === 0 && (await dirty()) === false, JSON.stringify(settled));
  await db.execute(sql`DELETE FROM interactions WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);

  console.log("\nThe build's concurrent prebuild...");
  const pre = concurrentIndexStatements([
    "CREATE INDEX IF NOT EXISTS a_idx ON interactions(user_id) WHERE memory_dirty",
    "CREATE UNIQUE INDEX IF NOT EXISTS b_uidx ON contacts(id)",
    "CREATE INDEX IF NOT EXISTS c_idx ON startup_expenses(incurred_at)",
  ]);
  check("rewrites plain index builds on big tables to CONCURRENTLY", pre.length === 1 && pre[0]!.sql === "CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON interactions(user_id) WHERE memory_dirty", JSON.stringify(pre));
  check("covers the new FK and flag indexes", ["memory_chunks_contact_idx", "interactions_memory_dirty_idx"].every((n) => concurrentIndexStatements(SCALE_DDL).some((s) => s.name === n)));
  check("adds the flag column first, which is metadata-only", metadataOnlyColumnAdds(SCALE_DDL).some((s) => s.includes("memory_dirty")));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll scale sweep guard checks passed.");
});
