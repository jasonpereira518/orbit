/**
 * "Does this database have everything `schema.ts` declares?" — asked against a live
 * connection, after the migration sweep has run. Shared by the build-time migration
 * (`scripts/migrate.ts`) and the upgrade smoke, so the answer the build gate gives is the
 * same one the test suite pins.
 */
import { is, sql } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { getDb, rowsOf } from "../../src/db";
import * as schema from "../../src/db/schema";

/** Created at runtime by `migratePgvector`, absent from `schema.ts` by design. */
const RUNTIME_MANAGED_COLUMNS = new Set(["contact_embeddings.embedding_vector"]);

export type CoverageReport = {
  missingColumns: string[];
  missingIndexes: string[];
};

export async function schemaCoverage(): Promise<CoverageReport> {
  const db = await getDb();
  const columnsRes = await db.execute(
    sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
  );
  const have = new Set(
    rowsOf<{ table_name: string; column_name: string }>(columnsRes).map(
      (r) => `${r.table_name}.${r.column_name}`
    )
  );
  const indexesRes = await db.execute(sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
  const haveIndexes = new Set(rowsOf<{ indexname: string }>(indexesRes).map((r) => r.indexname));

  const missingColumns: string[] = [];
  const missingIndexes: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    for (const col of cfg.columns) {
      const key = `${cfg.name}.${col.name}`;
      if (RUNTIME_MANAGED_COLUMNS.has(key)) continue;
      if (!have.has(key)) missingColumns.push(key);
    }
    for (const idx of cfg.indexes) {
      const name = idx.config.name;
      if (name && !haveIndexes.has(name)) missingIndexes.push(`${cfg.name}: ${name}`);
    }
  }
  return { missingColumns: missingColumns.sort(), missingIndexes: missingIndexes.sort() };
}
