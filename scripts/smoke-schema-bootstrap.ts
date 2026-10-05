/**
 * The FIRST sweep on a virgin database must report no failures.
 *
 * Every other schema smoke reconciles a database that `getDb()` has already bootstrapped, so
 * every table exists by the time they look. That leaves the one case where ordering inside
 * `applySchema` actually matters uncovered — and it is the case that reaches production, and
 * every preview and every developer's first `next dev`.
 *
 * What it caught: a CREATE TABLE written under an explanatory comment block did not look like
 * a CREATE TABLE to the `;`-split classifier (the comment stays attached to the front of the
 * statement), so it ran in the trailing pass, AFTER `alters`. The first ALTER naming that
 * table failed with "relation does not exist" on any database that did not already have it.
 *
 * The consequence is the reason this is a smoke and not a lint: `reconcileSchema` records the
 * version only when nothing failed, so one failing statement means every boot re-runs the
 * entire sweep under the migration lock. The app does not break, it gets slower on every
 * request — which showed up as a Playwright run timing out waiting for the dev server, four
 * levels away from the cause.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-schema-bootstrap.ts
 */
import "./smoke/_env";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

// A directory of this script's own, claimed BEFORE `../src/db` is loaded. `_env` already
// makes one, but `run-smoke.ts` hands every script in a suite run the SAME directory, so
// inside the suite this script would otherwise reconcile a database an earlier script had
// already built — and every check below would pass without testing anything. That is why
// `../src/db` is imported dynamically further down rather than at the top: a static import
// is hoisted above this assignment and would open PGlite at the shared path.
process.env.ORBIT_PGLITE_DIR = mkdtempSync(join(tmpdir(), "orbit-bootstrap-"));

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  const { SCHEMA_VERSION, getDb, reconcileSchema, rowsOf } = await import("../src/db");

  // The FIRST database call in this process, deliberately: the directory above is empty, so
  // this sweep is the bootstrap. Anything reaching `getDb()` before it would create the
  // schema first and leave every check below vacuous — which is exactly what happened when
  // this script trusted the suite's shared directory.
  const first = await reconcileSchema();

  check("the first sweep on an empty database runs", first.applied === true, JSON.stringify(first));
  check(
    "and every statement in it succeeds",
    first.failed.length === 0,
    first.failed.map((f) => `${f.statement}\n         ${f.message}`).join("\n       ")
  );

  // The consequence, stated separately: without this the version is never stamped and the
  // next boot sweeps again, and the one after that, forever.
  const db = await getDb();
  const stamped = rowsOf<{ version: number }>(
    await db.execute(sql`select version from schema_migrations order by version desc limit 1`)
  )[0];
  check(
    "so the version is recorded",
    Number(stamped?.version) === SCHEMA_VERSION,
    `recorded ${stamped?.version ?? "(none)"} , expected ${SCHEMA_VERSION}`
  );
  check("and the next boot does no work at all", (await reconcileSchema()).applied === false);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll schema-bootstrap checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
