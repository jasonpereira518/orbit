/**
 * The preamble every script that MIGRATES REAL DATA starts with.
 *
 *     import { requireRealDatabase } from "./lib/operational-db";
 *     requireRealDatabase("backfill-opportunities");
 *
 * It is the opposite number of `scripts/smoke/_env.ts`, and it exists because two backfills
 * imported that one by mistake.
 *
 * ## The failure it prevents
 *
 * The smoke preamble DELETES `DATABASE_URL` unless `SMOKE_ALLOW_REMOTE=1` and points the
 * driver at a throwaway PGlite directory — exactly right for a test, and silently wrong for
 * a migration. A backfill that imports it connects to an empty database, finds nothing to
 * do, and prints `contacts with legacy opportunities: 0`.
 *
 * That number is indistinguishable from "already done". The operator ticks the box, the
 * migration never ran, and in the case this was found in, the next capture would have
 * overwritten the very column the backfill existed to preserve.
 *
 * ## So this refuses rather than degrades
 *
 * `backfill-contact-identities.ts` prints which target it picked and carries on, which is
 * defensible for a job whose worst case is "runs again next deploy". It is not defensible
 * for a one-shot migration in front of a data-loss window: there, a run against the wrong
 * database that LOOKS like a clean run is worse than no run at all. So a missing
 * `DATABASE_URL` is an error with an exit code, and the target is printed before any work
 * begins — an operator should be able to see what they are about to change.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config();

/** Host and database only. Never the credentials — these scripts get run with output shared. */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "an unparseable DATABASE_URL";
  }
}

/**
 * Assert this process is pointed at a real database, and say which one.
 *
 * Returns the description so a caller can put it in its own summary line; throws with a
 * usable message rather than letting the driver fall back to PGlite.
 */
export function requireRealDatabase(scriptName: string): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error(
      `${scriptName}: DATABASE_URL is not set.\n` +
        `  This script migrates real data. Without it the driver falls back to a local\n` +
        `  PGlite database, which is empty — so the run would report zero rows and look\n` +
        `  exactly like a migration that had nothing left to do.\n` +
        `  Set DATABASE_URL (see .env.local) and run it again.`
    );
    process.exit(2);
  }
  const target = describeTarget(url);
  console.log(`${scriptName}: targeting ${target}`);
  return target;
}
