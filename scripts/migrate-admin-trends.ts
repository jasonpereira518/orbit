/**
 * Adds `admin_metric_snapshots` — the table backing the console's trend charts for
 * metrics that have no other historical record (see `src/lib/admin-trends.ts`).
 *
 * `getDb()` applies this DDL automatically on the next cold start once `SCHEMA_VERSION`
 * is bumped (it is, to 7). This script exists to force it onto local PGlite immediately,
 * without restarting the dev server, and as a way to run it against Neon directly if
 * needed. Uses DATABASE_URL (Neon) when set, otherwise local PGlite.
 *
 * Deliberately NOT `drizzle-kit push` — see migrate-admin-tables.ts for why.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";

const DDL = `CREATE TABLE IF NOT EXISTS admin_metric_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric text NOT NULL,
  value integer NOT NULL,
  captured_at date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`;

const INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS admin_metric_snapshots_metric_day_uidx ON admin_metric_snapshots(metric, captured_at)`,
  `CREATE INDEX IF NOT EXISTS admin_metric_snapshots_captured_idx ON admin_metric_snapshots(captured_at)`,
];

async function main() {
  const mode = process.env.DATABASE_URL?.trim() ? "neon" : "pglite";
  console.log(`Adding admin_metric_snapshots (${mode})…`);

  const db = await getDb();
  await db.execute(sql.raw(DDL));
  console.log("  ok admin_metric_snapshots");
  for (const statement of INDEXES) {
    await db.execute(sql.raw(statement));
  }
  console.log(`  ok ${INDEXES.length} indexes`);

  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'admin_metric_snapshots'
  `);
  if (rowsOf<unknown>(tables).length === 0) {
    throw new Error("admin_metric_snapshots still missing after migration");
  }

  console.log("Done.");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
