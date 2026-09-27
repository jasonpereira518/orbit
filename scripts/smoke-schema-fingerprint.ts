/**
 * The schema version is recorded with a fingerprint of the DDL that produced it, so a burned
 * version number cannot skip another branch's statements, and a rollback never re-sweeps.
 *
 * Run: npx tsx scripts/smoke-schema-fingerprint.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { SCHEMA_VERSION, getDb, isSchemaCurrent, reconcileSchema, rowsOf, schemaFingerprint } from "../src/db";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

run(async () => {
  const db = await getDb();
  const recorded = async () =>
    rowsOf<{ version: number | string; fingerprint: string | null }>(
      await db.execute(sql`SELECT version, fingerprint FROM schema_migrations WHERE id = 1`))[0];
  const fp = schemaFingerprint();

  console.log("The decision (isSchemaCurrent)...");
  check("the fingerprint is a stable sha256", /^[0-9a-f]{64}$/.test(fp) && fp === schemaFingerprint());
  check("no row → sweep", !isSchemaCurrent(null));
  check("behind → sweep", !isSchemaCurrent({ version: SCHEMA_VERSION - 1, fingerprint: fp }));
  check("ahead (a rollback is serving) → leave it", isSchemaCurrent({ version: SCHEMA_VERSION + 1, fingerprint: "other" }));
  check("same number, same DDL → leave it", isSchemaCurrent({ version: SCHEMA_VERSION, fingerprint: fp }));
  check("same number, other DDL (a burned number) → sweep", !isSchemaCurrent({ version: SCHEMA_VERSION, fingerprint: "another-branch" }));
  check("same number, stamped before fingerprints → sweep", !isSchemaCurrent({ version: SCHEMA_VERSION, fingerprint: null }));

  console.log("\nA fresh database...");
  const fresh = await recorded();
  check("records version and fingerprint", Number(fresh?.version) === SCHEMA_VERSION && fresh?.fingerprint === fp, JSON.stringify(fresh));

  console.log("\nA burned number: same version, another branch's DDL...");
  await db.execute(sql`DROP INDEX IF EXISTS contacts_embedding_stale_idx`);
  await db.execute(sql`UPDATE schema_migrations SET fingerprint = 'another-branch' WHERE id = 1`);
  const burned = await reconcileSchema();
  check("the sweep runs although the version matches", burned.applied === true && burned.failed.length === 0, JSON.stringify(burned));
  check("a statement the burned number would have skipped ran",
    rowsOf(await db.execute(sql`SELECT 1 FROM pg_indexes WHERE indexname = 'contacts_embedding_stale_idx'`)).length === 1);
  check("this build's fingerprint is recorded", (await recorded())?.fingerprint === fp);
  check("and the next reconcile is a no-op", (await reconcileSchema()).applied === false);

  console.log("\nA database stamped before the column existed...");
  await db.execute(sql`ALTER TABLE schema_migrations DROP COLUMN fingerprint`);
  const legacy = await reconcileSchema();
  check("takes the full pass once", legacy.applied === true && legacy.failed.length === 0, JSON.stringify(legacy));
  check("and gains the column with this build's fingerprint", (await recorded())?.fingerprint === fp);

  console.log("\nA newer build already migrated this database...");
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION + 1}, fingerprint = 'newer-build' WHERE id = 1`);
  check("an older build does not re-sweep", (await reconcileSchema()).applied === false);
  const kept = await recorded();
  check("and never overwrites the newer stamp", Number(kept?.version) === SCHEMA_VERSION + 1 && kept?.fingerprint === "newer-build", JSON.stringify(kept));

  // Leave the shared PGlite as every later script expects it.
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION}, fingerprint = ${fp} WHERE id = 1`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll schema-fingerprint checks passed.");
});
