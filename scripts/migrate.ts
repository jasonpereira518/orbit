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

import { SCHEMA_VERSION, reconcileSchema } from "../src/db";
import { schemaCoverage } from "./lib/schema-coverage";

async function main() {
  const target = process.env.DATABASE_URL?.trim() ? "DATABASE_URL" : "local PGlite";
  if (process.env.VERCEL && !process.env.DATABASE_URL?.trim()) {
    console.error("migrate: DATABASE_URL is unset in a Vercel build — refusing to guess.");
    process.exit(1);
  }
  console.log(`migrate: reconciling schema version ${SCHEMA_VERSION} on ${target}…`);

  const result = await reconcileSchema();
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

  console.log(
    `migrate: schema version ${SCHEMA_VERSION} ${result.applied ? "applied" : "already current"}; ${target} matches schema.ts.`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
