/**
 * Pins the shape of `.github/workflows/backup.yml`, which failed on every run it ever had
 * (both secrets empty) while nothing said so (audit A1).
 *
 * Text positions on purpose: no YAML dependency, and what matters is ORDER — the secrets
 * guard must run before the dump, and the page must run when anything fails.
 *
 * Pure. Run: npx tsx scripts/smoke-backup-workflow.ts
 */
import { readFileSync } from "node:fs";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const src = readFileSync(".github/workflows/backup.yml", "utf8");

/** The text of the step starting at `at`, up to the next step. */
function stepAt(at: number): string {
  if (at < 0) return "";
  const next = src.indexOf("\n      - ", at + 1);
  return src.slice(at, next === -1 ? undefined : next);
}

const guardAt = src.indexOf("- name: Refuse to run without the backup secrets");
const installAt = src.indexOf("- name: Install pg_dump");
const dumpAt = src.indexOf("- name: Dump and encrypt");
const uploadAt = src.indexOf("- uses: actions/upload-artifact");
const pageAt = src.indexOf("- name: Page on a failed backup");
const guard = stepAt(guardAt);
const dump = stepAt(dumpAt);
const page = stepAt(pageAt);

console.log("The secrets are checked before anything else");
check("a guard step exists", guardAt !== -1);
check("…and runs before the install and the dump", guardAt !== -1 && guardAt < installAt && guardAt < dumpAt, `${guardAt} ${installAt} ${dumpAt}`);
check("…tests DATABASE_URL is non-empty", guard.includes('[ -n "$DATABASE_URL" ]'));
check("…tests BACKUP_AGE_PUBLIC_KEY is non-empty", guard.includes('[ -n "$BACKUP_AGE_PUBLIC_KEY" ]'));
check("…checks the key is an age recipient", guard.includes("age1*"));
check("…fails the job with a readable error", guard.includes("::error") && guard.includes("exit 1"));
check("…and actually receives both secrets", guard.includes("secrets.DATABASE_URL") && guard.includes("secrets.BACKUP_AGE_PUBLIC_KEY"));

console.log("\nA failed pg_dump cannot upload an empty encrypted file");
const pipefailAt = dump.indexOf("set -o pipefail");
check("the dump step sets pipefail before piping pg_dump into age", pipefailAt !== -1 && pipefailAt < dump.indexOf("pg_dump --format"));

console.log("\nAny failure pages #orbit-ops-critical");
check("a failure step exists", pageAt !== -1);
check("…gated on failure()", page.includes("if: failure()"));
check("…placed after the upload, so a missing artifact pages too", pageAt > uploadAt && uploadAt !== -1);
check("…posts to SLACK_OPS_CRITICAL_WEBHOOK_URL", page.includes("secrets.SLACK_OPS_CRITICAL_WEBHOOK_URL") && page.includes('"$SLACK_OPS_CRITICAL_WEBHOOK_URL"'));
check("…and skips quietly when the webhook is unset", page.includes('[ -z "$SLACK_OPS_CRITICAL_WEBHOOK_URL" ]') && page.includes("exit 0"));

console.log("\nThe client can dump the server it points at");
// pg_dump refuses a server newer than itself ("aborting because of server version
// mismatch"). Production Neon is Postgres 18; Ubuntu 24.04 ships client 16, and the old
// `postgresql-client-17 || postgresql-client` fallback silently installed 16. Every run
// would have failed on the version even after the secrets were set.
const install = stepAt(installAt);
const major = /PG_MAJOR: "(\d+)"/.exec(src)?.[1];
check("the client major version is pinned in one place", Boolean(major), "PG_MAJOR not found");
check("…at least 18, the production server's major", Number(major) >= 18, `PG_MAJOR=${major}`);
check("the install adds the PostgreSQL apt repository", install.includes("apt.postgresql.org.sh"));
check("…installs the pinned client", install.includes('postgresql-client-"$PG_MAJOR"'));
check("…and never falls back to Ubuntu's older client", !install.includes("postgresql-client age") && !install.includes("|| \\"));
// Debian's pg_wrapper can pick the runner's preinstalled 16 cluster over a newer client, so
// the dump names the pinned binary directory rather than trusting whichever `pg_dump` wins.
check("…and puts the pinned client's bin directory first on PATH", install.includes('/usr/lib/postgresql/$PG_MAJOR/bin') && install.includes("GITHUB_PATH"));
check("the dump proves pg_dump is the pinned major before dumping",
  dump.includes("pg_dump --version") && dump.includes("$PG_MAJOR") && dump.indexOf("pg_dump --version") < dump.indexOf("pg_dump --format"));

console.log("\nA stored backup pings its own heartbeat (backup.stale is Better Stack's job)");
const beatAt = src.indexOf("- name: Tell Better Stack the backup landed");
const beat = stepAt(beatAt);
check("a heartbeat step exists", beatAt !== -1);
check("…after the upload, so it means a dump was stored", uploadAt !== -1 && beatAt > uploadAt, `${uploadAt} ${beatAt}`);
check("…before the failure page, which stays last", pageAt > beatAt);
check("…runs only on success (no if: always()/failure())", !/\bif:/.test(beat));
check("…reads BETTERSTACK_BACKUP_HEARTBEAT_URL from secrets",
  beat.includes("secrets.BETTERSTACK_BACKUP_HEARTBEAT_URL") && beat.includes('"$BETTERSTACK_BACKUP_HEARTBEAT_URL"'));
check("…skips quietly when the secret is unset",
  beat.includes('[ -z "$BETTERSTACK_BACKUP_HEARTBEAT_URL" ]') && beat.includes("exit 0"));
check("…and can never fail the job (a Better Stack outage is not a failed backup)",
  beat.includes("--max-time") && beat.includes("|| echo"));
check("the header names the secret", src.slice(0, src.indexOf("name: backup")).includes("BETTERSTACK_BACKUP_HEARTBEAT_URL"));

console.log("\nThe schedule is unchanged");
check("still daily", src.includes('cron: "0 6 * * *"'));
check("still runnable by hand", src.includes("workflow_dispatch:"));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll backup-workflow checks passed.");
process.exit(0);
