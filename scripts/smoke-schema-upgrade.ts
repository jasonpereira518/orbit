/**
 * Asserts the migration sweep leaves a database matching `schema.ts` — on a FRESH database,
 * and on one that is a version behind and missing a column.
 *
 * The second case is the one that bit production: the `DDL` template creates
 * `contacts_user_x_idx` on `contacts(x_handle)`, but on a database that predates that
 * column the `ALTER TABLE ... ADD COLUMN x_handle` lives in the `alters` list, which used
 * to run AFTER the template. The index statement failed, the sweep logged it and carried
 * on, and the version was bumped anyway — so the index has been silently missing since
 * August. `reconcileSchema()` now orders statements so columns always precede indexes and
 * REPORTS what failed instead of only logging it; this pins both.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-schema-upgrade.ts
 */
import "./smoke/_env";

import { sql } from "drizzle-orm";
import { SCHEMA_VERSION, getDb, reconcileSchema, rowsOf } from "../src/db";
import { schemaCoverage } from "./lib/schema-coverage";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function recordedVersion() {
  const db = await getDb();
  const res = await db.execute(sql`SELECT version FROM schema_migrations WHERE id = 1`);
  return Number(rowsOf<{ version: number | string }>(res)[0]?.version);
}

async function main() {
  console.log("Fresh database...");
  await getDb();
  check("version recorded as SCHEMA_VERSION", (await recordedVersion()) === SCHEMA_VERSION);
  let cov = await schemaCoverage();
  check("every column in schema.ts exists", cov.missingColumns.length === 0, cov.missingColumns.join(", "));
  check("every index in schema.ts exists", cov.missingIndexes.length === 0, cov.missingIndexes.join(", "));

  console.log("\nA database one version behind, missing a column its index needs...");
  const db = await getDb();
  await db.execute(sql`ALTER TABLE contacts DROP COLUMN x_handle`);
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1} WHERE id = 1`);
  const before = await db.execute(sql`SELECT 1 FROM pg_indexes WHERE indexname = 'contacts_user_x_idx'`);
  check("fixture: dropping the column also dropped its index", rowsOf(before).length === 0);

  const result = await reconcileSchema();
  check("the sweep ran (version was behind)", result.applied === true, JSON.stringify(result));
  check("no DDL statement failed", result.failed.length === 0, result.failed.map((f) => `${f.statement.slice(0, 60)} → ${f.message}`).join("\n       "));
  const after = await db.execute(sql`SELECT 1 FROM pg_indexes WHERE indexname = 'contacts_user_x_idx'`);
  check("the column's index is back", rowsOf(after).length === 1);
  cov = await schemaCoverage();
  check("every column exists again", cov.missingColumns.length === 0, cov.missingColumns.join(", "));
  check("version recorded again", (await recordedVersion()) === SCHEMA_VERSION);

  const again = await reconcileSchema();
  check("a current database is a no-op", again.applied === false && again.failed.length === 0, JSON.stringify(again));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll schema-upgrade checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
