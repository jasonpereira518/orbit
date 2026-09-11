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
 * The third case is the version number lying. Two branches claimed the same
 * `SCHEMA_VERSION` with different DDL; whichever migrated a database first stamped it, and
 * the other read "current" and skipped its sweep entirely. The gate now also compares a
 * fingerprint of the DDL itself, and this asserts a database stamped with OUR number but
 * someone else's DDL still gets our columns — the failure that blocked PR #152's preview.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-schema-upgrade.ts
 */
import "./smoke/_env";

import { sql } from "drizzle-orm";
import { SCHEMA_VERSION, getDb, reconcileSchema, rowsOf, schemaFingerprint } from "../src/db";
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

async function recordedFingerprint() {
  const db = await getDb();
  const res = await db.execute(sql`SELECT fingerprint FROM schema_migrations WHERE id = 1`);
  return rowsOf<{ fingerprint: string | null }>(res)[0]?.fingerprint ?? null;
}

async function columnPresent(table: string, column: string) {
  const db = await getDb();
  const res = await db.execute(sql`
    SELECT 1 FROM information_schema.columns WHERE table_name = ${table} AND column_name = ${column}
  `);
  return rowsOf(res).length === 1;
}

async function main() {
  console.log("Fresh database...");
  await getDb();
  check("version recorded as SCHEMA_VERSION", (await recordedVersion()) === SCHEMA_VERSION);
  check("fingerprint recorded alongside it", (await recordedFingerprint()) === schemaFingerprint());
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

  console.log("\nThe right version number, but another branch's DDL...");
  {
    // Exactly PR #152's preview: the database says our version, because a different branch
    // with the same number migrated it first, and one of our columns is missing. Comparing
    // the integer alone, this skipped the sweep and the column never appeared.
    await db.execute(sql`ALTER TABLE contacts DROP COLUMN x_handle`);
    await db.execute(sql`
      UPDATE schema_migrations SET version = ${SCHEMA_VERSION}, fingerprint = ${"0".repeat(64)} WHERE id = 1
    `);
    check("fixture: the version still claims to be current", (await recordedVersion()) === SCHEMA_VERSION);
    check("fixture: the column is gone", !(await columnPresent("contacts", "x_handle")));

    const collided = await reconcileSchema();
    check("a matching version with a different fingerprint still runs the sweep", collided.applied === true, JSON.stringify(collided));
    check("and nothing failed", collided.failed.length === 0, collided.failed.map((f) => f.message).join("; "));
    check("so the column comes back", await columnPresent("contacts", "x_handle"));
    check("and this build's fingerprint is recorded", (await recordedFingerprint()) === schemaFingerprint());
  }

  console.log("\nA database from before the fingerprint existed...");
  {
    // Every production database, the moment this change deploys. Selecting a column it does
    // not have must take the full pass once, add the column, and then settle.
    await db.execute(sql`ALTER TABLE schema_migrations DROP COLUMN fingerprint`);
    const upgraded = await reconcileSchema();
    check("the missing column is treated as not current", upgraded.applied === true, JSON.stringify(upgraded));
    check("the column is added on the way out", await columnPresent("schema_migrations", "fingerprint"));
    check("and filled in", (await recordedFingerprint()) === schemaFingerprint());
    const settled = await reconcileSchema();
    check("after which it is back on the fast path", settled.applied === false, JSON.stringify(settled));
  }

  const again = await reconcileSchema();
  check("a current database is a no-op", again.applied === false && again.failed.length === 0, JSON.stringify(again));
  check("the fingerprint is stable across calls", schemaFingerprint() === schemaFingerprint());

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
