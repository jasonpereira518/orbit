/**
 * The one preamble every database-touching smoke script starts with.
 *
 *   import "./smoke/_env";
 *
 * It does three things, in an order that matters:
 *
 *   1. Loads `.env.local` and `.env` the way every script always has.
 *   2. DELETES `DATABASE_URL` unless `SMOKE_ALLOW_REMOTE=1`. `getDb()` picks PGlite exactly
 *      when that variable is unset, and this repo's `.env.local` points it at the shared
 *      Neon database — so a script whose header says "runs against local PGlite" was, for
 *      every script that forgot this line, hard-deleting rows in the remote database. dotenv
 *      only fills in UNSET variables, which is why the delete has to come after it.
 *   3. Points PGlite at a throwaway directory (`ORBIT_PGLITE_DIR`), so smoke runs never
 *      contend with a dev server's `.data/pglite` (two writers corrupt it) and every run
 *      bootstraps the full DDL on a fresh database — free schema coverage.
 *
 * `scripts/run-smoke.ts` refuses to run any database-tier script that does not import
 * this module, so the footgun cannot come back one script at a time.
 */
import { config } from "dotenv";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

config({ path: ".env.local" });
config();

if (process.env.SMOKE_ALLOW_REMOTE !== "1") {
  delete process.env.DATABASE_URL;
}

if (!process.env.ORBIT_PGLITE_DIR) {
  process.env.ORBIT_PGLITE_DIR = mkdtempSync(join(tmpdir(), "orbit-smoke-"));
}

/** `main().then(exit 0).catch(log, exit 1)` — tsx keeps the loop alive on PGlite's workers without it. */
export function run(main: () => Promise<unknown>): void {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
