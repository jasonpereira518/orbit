/**
 * Build-time migration. Runs in the Vercel build command ahead of `next build`:
 *
 *   npm run check:env && npm run db:migrate && next build
 *
 * so the schema is current BEFORE the deployment goes live, instead of on the first
 * request of the first cold start — where two concurrent boots raced it, a failing
 * statement was only logged, and the version was recorded regardless. A migration that
 * fails here fails the build, the last good deployment stays aliased, and the build log
 * says exactly which statement broke.
 *
 * Targets whatever `DATABASE_URL` says (the production database on a production build);
 * locally, without one, the worktree's PGlite. NOT a smoke script and deliberately not
 * behind `scripts/smoke/_env.ts` — reaching the real database is the point.
 *
 * Run: npx tsx scripts/migrate.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { BUILD_MIGRATION_LOCK_WAIT_MS, SCHEMA_VERSION, reconcileSchema } from "../src/db";
import { checkMigrationTarget, type VercelEnv } from "../src/lib/env";
import { schemaCoverage } from "./lib/schema-coverage";

async function main() {
  // Migrate through a dedicated connection when one is given. The app role carries
  // `statement_timeout` (docs/RUNBOOK.md) and has no business holding DDL rights; the
  // migration role can carry a long statement_timeout and a short lock_timeout of its own.
  // Unset, the build migrates through DATABASE_URL exactly as before.
  const migrationUrl = process.env.MIGRATION_DATABASE_URL?.trim();
  if (migrationUrl) process.env.DATABASE_URL = migrationUrl;

  const target = migrationUrl ? "MIGRATION_DATABASE_URL" : process.env.DATABASE_URL?.trim() ? "DATABASE_URL" : "local PGlite";
  if (process.env.VERCEL && !process.env.DATABASE_URL?.trim()) {
    console.error("migrate: DATABASE_URL is unset in a Vercel build — refusing to guess.");
    process.exit(1);
  }

  // Before anything touches the database: is this build even allowed to migrate what it is
  // pointed at? A preview build sharing production's DATABASE_URL would otherwise run the
  // DDL and both backfills below against live customer data.
  const verdict = checkMigrationTarget(process.env, {
    vercelEnv: process.env.VERCEL_ENV as VercelEnv,
  });
  if (!verdict.allowed) {
    console.error(`migrate: refusing to migrate. ${verdict.reason}`);
    process.exit(1);
  }
  if (verdict.allowed && verdict.unarmed) console.warn(`migrate: warn  ${verdict.reason}`);
  console.log(`migrate: reconciling schema version ${SCHEMA_VERSION} on ${target}…`);

  const result = await reconcileSchema({ lockWaitMs: BUILD_MIGRATION_LOCK_WAIT_MS, onLockTimeout: "sweep" });
  if (result.failed.length > 0) {
    console.error(`migrate: ${result.failed.length} DDL statement(s) failed:`);
    for (const f of result.failed) console.error(`  ✗ ${f.statement}\n      ${f.message}`);
    console.error("migrate: refusing to build on a partially migrated schema.");
    process.exit(1);
  }

  const cov = await schemaCoverage();
  if (cov.missingColumns.length > 0 || cov.missingIndexes.length > 0) {
    for (const c of cov.missingColumns) console.error(`  ✗ column missing after migrate: ${c}`);
    for (const i of cov.missingIndexes) console.error(`  ✗ index missing after migrate: ${i}`);
    console.error("migrate: schema.ts declares things the DDL never creates. See scripts/smoke-schema-ddl.ts.");
    process.exit(1);
  }

  // No data work here. The contact-identity backfill and the confident-duplicate merges used
  // to run at this point on every build: they rewrote customer data even when the `next build`
  // after them then failed (the database moves on, the old code keeps serving), and a merge is
  // hard to undo. They run from the hourly housekeeping now (`runIdentityMaintenance`,
  // called by /api/imports/process-stalled), bounded the same way.

  console.log(
    `migrate: schema version ${SCHEMA_VERSION} ${result.applied ? "applied" : "already current"}; ${target} matches schema.ts.`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
