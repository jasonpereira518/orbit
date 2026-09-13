/**
 * The two guards standing between a build and the wrong database.
 *
 * `vercel.json` runs `npm run db:migrate` in EVERY environment, and `scripts/migrate.ts`
 * does more than DDL — it backfills `contact_identities` and merges confident duplicates,
 * both of which write. So a preview build that inherited production's `DATABASE_URL` (the
 * default if the variable is scoped to "All Environments") writes to live customer data on
 * every pull request. `checkMigrationTarget` is the backstop for that; the migration lease
 * is what stops two builders interleaving the DDL.
 *
 * The target check is pure. The lease half touches the database, hence `./smoke/_env`.
 *
 * Run: npx tsx scripts/smoke-migration-guards.ts
 */
import "./smoke/_env";
import { sql } from "drizzle-orm";
import { checkMigrationTarget, databaseHost, validateEnv } from "../src/lib/env";
import { getDb, reconcileSchema } from "../src/db";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const PROD = "ep-prod-1234.us-east-2.aws.neon.tech";
const BRANCH = "ep-preview-5678.us-east-2.aws.neon.tech";
const urlFor = (host: string) => `postgres://user:secret@${host}/orbit?sslmode=require`;

const rowsOf = (result: unknown): unknown[] => {
  const r = result as { rows?: unknown[] } | unknown[];
  return Array.isArray(r) ? r : (r.rows ?? []);
};

function targetChecks() {
  console.log("databaseHost...");
  check("reads the host out of a postgres URL", databaseHost(urlFor(PROD)) === PROD);
  check("lowercases", databaseHost(urlFor(PROD.toUpperCase())) === PROD);
  check("null for unset and unparseable", databaseHost(undefined) === null && databaseHost("not a url") === null);
  check("never returns credentials", !JSON.stringify(databaseHost(urlFor(PROD))).includes("secret"));

  console.log("\ncheckMigrationTarget...");
  const armed = { VERCEL: "1", PRODUCTION_DB_HOST: PROD };

  check(
    "a preview build pointed at production is refused",
    checkMigrationTarget({ ...armed, DATABASE_URL: urlFor(PROD) }, { vercelEnv: "preview" }).allowed === false
  );
  const refusal = checkMigrationTarget({ ...armed, DATABASE_URL: urlFor(PROD) }, { vercelEnv: "preview" });
  check("the refusal names the host and the fix, not the password",
    refusal.reason.includes(PROD) && refusal.reason.includes("Neon branch") && !refusal.reason.includes("secret"),
    refusal.reason);

  check(
    "a preview build on its own branch is allowed",
    checkMigrationTarget({ ...armed, DATABASE_URL: urlFor(BRANCH) }, { vercelEnv: "preview" }).allowed === true
  );
  check(
    "the production build migrating production is allowed",
    checkMigrationTarget({ ...armed, DATABASE_URL: urlFor(PROD) }, { vercelEnv: "production" }).allowed === true
  );
  check(
    "a local run is allowed and never consults the host",
    checkMigrationTarget({ DATABASE_URL: urlFor(PROD), PRODUCTION_DB_HOST: PROD }, { vercelEnv: undefined }).allowed === true
  );

  // The deliberate non-fail-closed case: refusing every preview build until a new variable
  // exists breaks previews to prevent a hypothetical, and a broken preview pipeline is how
  // guards get deleted.
  const unarmed = checkMigrationTarget({ VERCEL: "1", DATABASE_URL: urlFor(PROD) }, { vercelEnv: "preview" });
  check("without PRODUCTION_DB_HOST it allows but reports itself unarmed",
    unarmed.allowed === true && unarmed.unarmed === true && unarmed.reason.includes("PRODUCTION_DB_HOST"));

  check(
    "check-env warns about the unarmed guard in preview",
    validateEnv({ DATABASE_URL: urlFor(BRANCH), NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_x", CLERK_SECRET_KEY: "sk_test_x", ENCRYPTION_SECRET: "x".repeat(40) }, { vercelEnv: "preview" })
      .warnings.some((w) => w.includes("PRODUCTION_DB_HOST"))
  );
}

async function leaseChecks() {
  console.log("\nMigration lease...");
  const db = await getDb();

  // `_env` gave us a fresh PGlite directory, so getDb() has already run one full sweep.
  check("the lease is released once the sweep finishes",
    rowsOf(await db.execute(sql`SELECT * FROM schema_migration_lock`)).length === 0);

  // Plant a live lease held by someone else and force a version mismatch, so the sweep is
  // actually attempted rather than short-circuited by schemaIsCurrent.
  await db.execute(sql`INSERT INTO schema_migration_lock (id, holder, acquired_at, expires_at)
    VALUES (1, 'another-builder', now(), now() + interval '30 seconds')
    ON CONFLICT (id) DO UPDATE SET holder = 'another-builder', expires_at = now() + interval '30 seconds'`);
  await db.execute(sql`UPDATE schema_migrations SET version = 1 WHERE id = 1`);

  const started = Date.now();
  const release = setTimeout(() => {
    void db.execute(sql`DELETE FROM schema_migration_lock WHERE holder = 'another-builder'`);
  }, 3000);

  const result = await reconcileSchema();
  clearTimeout(release);
  const waited = Date.now() - started;

  check("a live lease makes the second builder wait rather than sweep", waited >= 3000, `waited ${waited}ms`);
  check("it sweeps once the lease is released", result.applied === true);
  check("the sweep reports no failures", result.failed.length === 0,
    result.failed.map((f) => f.statement).join("; "));
  check("and releases its own lease afterwards",
    rowsOf(await db.execute(sql`SELECT * FROM schema_migration_lock`)).length === 0);

  // An expired lease must be stealable, or one crashed builder wedges every later deploy.
  await db.execute(sql`INSERT INTO schema_migration_lock (id, holder, acquired_at, expires_at)
    VALUES (1, 'builder-that-died', now() - interval '1 hour', now() - interval '55 minutes')
    ON CONFLICT (id) DO UPDATE SET holder = 'builder-that-died', expires_at = now() - interval '55 minutes'`);
  await db.execute(sql`UPDATE schema_migrations SET version = 1 WHERE id = 1`);

  const stealStarted = Date.now();
  const stolen = await reconcileSchema();
  check("an expired lease is taken immediately, not waited out",
    Date.now() - stealStarted < 2000 && stolen.applied === true, `${Date.now() - stealStarted}ms`);
  check("nothing failed on the stolen sweep", stolen.failed.length === 0);
}

async function main() {
  targetChecks();
  await leaseChecks();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll migration-guard checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
