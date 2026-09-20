/**
 * The one preamble every database-touching smoke script starts with.
 *
 *   import "./smoke/_env";
 *
 * It does four things, in an order that matters:
 *
 *   1. Loads `.env.local` and `.env` the way every script always has.
 *   2. DELETES `DATABASE_URL` unless `SMOKE_ALLOW_REMOTE=1`. `getDb()` picks PGlite exactly
 *      when that variable is unset, and this repo's `.env.local` points it at the shared
 *      Neon database — so a script whose header says "runs against local PGlite" was, for
 *      every script that forgot this line, hard-deleting rows in the remote database. dotenv
 *      only fills in UNSET variables, which is why the delete has to come after it.
 *   3. DELETES every billable provider key unless `SMOKE_ALLOW_PROVIDER_KEYS=1` — the
 *      local-dev AI keys, their `ORBIT_MANAGED_*` twins, Apollo and Resend. Off Vercel the AI
 *      gate treats a `GEMINI_API_KEY` in `.env.local` as a managed key, so a developer's real
 *      key turned "no key configured" cases into live, billed provider calls (and failures
 *      when the account ran dry). CI has no `.env.local`, which is why only laptops saw it.
 *      A script that needs a key sets a fake one itself, after this import.
 *   4. Points PGlite at a throwaway directory (`ORBIT_PGLITE_DIR`), so smoke runs never
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

/** Every environment variable that, if real, lets a smoke run spend money with a provider. */
export const PROVIDER_KEY_ENV = [
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "WISPR_API_KEY",
  "ORBIT_MANAGED_GEMINI_API_KEY",
  "ORBIT_MANAGED_OPENAI_API_KEY",
  "ORBIT_MANAGED_ANTHROPIC_API_KEY",
  "ORBIT_MANAGED_WISPR_API_KEY",
  "APOLLO_API_KEY",
  "RESEND_API_KEY",
] as const;

if (process.env.SMOKE_ALLOW_PROVIDER_KEYS !== "1") {
  for (const name of PROVIDER_KEY_ENV) delete process.env[name];
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
