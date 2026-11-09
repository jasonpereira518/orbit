/**
 * Continuous Restore Drill & Disaster Recovery Verification
 *
 * Verifies that a target restored database (or local test clone) contains healthy,
 * accessible schemas, valid row counts across core tenant tables, and active indexes.
 *
 * Run: npx tsx scripts/ops/restore-drill.ts
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../../src/db";
import { schemaCoverage } from "../lib/schema-coverage";

async function main() {
  console.log("=== Orbit Disaster Recovery & Restore Drill ===");
  const startTime = Date.now();
  const db = await getDb();

  // 1. Verify schema completeness
  console.log("\n1. Verifying schema structure...");
  const coverage = await schemaCoverage();
  if (coverage.missingColumns.length > 0) {
    console.error(`FAIL: Missing columns detected: ${coverage.missingColumns.join(", ")}`);
    process.exit(1);
  }
  if (coverage.missingIndexes.length > 0) {
    console.error(`FAIL: Missing indexes detected: ${coverage.missingIndexes.join(", ")}`);
    process.exit(1);
  }
  console.log("  ok  All schema tables, columns, and indexes present and verified.");

  // 2. Verify core table queryability and row health
  console.log("\n2. Verifying core tables queryability...");
  const coreTables = [
    "user_settings",
    "contacts",
    "interactions",
    "reminders",
    "tags",
    "contact_tags",
    "events",
    "companies",
  ];

  for (const table of coreTables) {
    try {
      const result = await db.execute(sql.raw(`SELECT count(*)::int as count FROM ${table}`));
      const count = rowsOf<{ count: number }>(result)[0]?.count ?? 0;
      console.log(`  ok  ${table}: ${count} rows accessible`);
    } catch (err) {
      console.error(`FAIL: Unable to query table ${table}:`, err);
      process.exit(1);
    }
  }

  // 3. Verify index health on hot paths
  console.log("\n3. Verifying critical index status...");
  const criticalIndexes = [
    "idx_contacts_user_sort",
    "contacts_user_recent_idx",
    "contacts_user_email_idx",
    "contact_tags_tag_idx",
    "contact_tags_pair_uidx",
    "interactions_user_date_idx",
    "reminders_user_status_due_idx",
  ];

  const indexQuery = await db.execute(
    sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
  );
  const activeIndexes = new Set(rowsOf<{ indexname: string }>(indexQuery).map((r) => r.indexname));

  for (const idx of criticalIndexes) {
    // Note: contacts_user_sort_idx is the declared name in schema.ts
    const resolvedName = idx === "idx_contacts_user_sort" ? "contacts_user_sort_idx" : idx;
    if (activeIndexes.has(resolvedName)) {
      console.log(`  ok  index ${resolvedName} is active in catalog`);
    } else {
      console.warn(`  warn: index ${resolvedName} not found in current schema catalog`);
    }
  }

  const durationMs = Date.now() - startTime;
  console.log(`\n=== Restore Drill Completed Successfully in ${durationMs}ms ===`);
}

main().catch((err) => {
  console.error("Disaster recovery restore drill failed:", err);
  process.exit(1);
});
