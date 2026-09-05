/**
 * Runs the smoke scripts as a suite, with a nonzero exit code, a summary, and a
 * structural guard that keeps them safe to run anywhere.
 *
 * Every script under `scripts/smoke-*.ts` is an executable spec with prose output and its
 * own exit code. What was missing was the harness: something that runs them all, fails
 * loudly, and — the important part — refuses to run a database-tier script that does not
 * start with `scripts/smoke/_env.ts`, because that preamble is the only thing standing
 * between "smoke test" and "delete rows in the shared Neon database".
 *
 * Tiers:
 *   pure    — no database, no network. Safe anywhere.
 *   pglite  — uses `getDb()` against a throwaway PGlite directory (via the preamble).
 *   manual  — wall-clock budgets or long runs; not part of `--ci`.
 *
 * Scripts run SEQUENTIALLY: PGlite is single-writer, and the pglite tier shares one
 * throwaway directory per run so the DDL bootstraps once, not fifty times.
 *
 * Run: npx tsx scripts/run-smoke.ts [--ci] [--check] [--only <name>...]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Tier = "pure" | "pglite" | "manual";

/** Every smoke script, by tier. `--check` fails when a script on disk is missing here. */
const MANIFEST: Record<string, Tier> = {
  // pure ------------------------------------------------------------------------------
  "smoke-admin-gate": "pure",
  "smoke-admin-yc-calculations": "pure",
  "smoke-avatar-storage": "pure",
  "smoke-capture-body-limits": "pure",
  "smoke-chat-pipeline": "pure",
  "smoke-chat-prompt": "pure",
  "smoke-chat-retrieval": "pure",
  "smoke-chat-stream": "pure",
  "smoke-closeness": "pure",
  "smoke-closeness-materialized": "pure",
  "smoke-constellation-eligibility": "pure",
  "smoke-contact-profile-format": "pure",
  "smoke-dashboard-search": "pure",
  "smoke-date-commitments": "pure",
  "smoke-duplicate-index": "pure",
  "smoke-embedding-cache": "pure",
  "smoke-env": "pure",
  "smoke-fast-model": "pure",
  "smoke-gmail-send-mime": "pure",
  "smoke-graph-intro": "pure",
  "smoke-graph-layout": "pure",
  "smoke-graph-positions": "pure",
  "smoke-graph-scope": "pure",
  "smoke-ics-feed": "pure",
  "smoke-import-progress-card": "pure",
  "smoke-lifetime-pricing": "pure",
  "smoke-locked-participant": "pure",
  "smoke-mention-resolution": "pure",
  "smoke-note-parse-schema": "pure",
  "smoke-ops-alerts": "pure",
  "smoke-parsers": "pure",
  "smoke-public-routes": "pure",
  "smoke-recruiter-scan": "pure",
  "smoke-relative-date": "pure",
  "smoke-scale-schema": "pure", // own in-memory PGlite
  "smoke-schema-ddl": "pure",
  "smoke-security-headers": "pure",
  "smoke-warp-chrono": "pure",
  "smoke-warp-journeys": "pure",
  // pglite ----------------------------------------------------------------------------
  "smoke-account-alerts": "pglite",
  "smoke-action-items": "pglite",
  "smoke-admin": "pglite",
  "smoke-app-pulse": "pglite",
  "smoke-admin-actions": "pglite",
  "smoke-admin-yc-render": "pglite",
  "smoke-admin-export": "pglite",
  "smoke-admin-render": "pglite",
  "smoke-admin-roster": "pglite",
  "smoke-admin-unmasked": "pglite",
  "smoke-avatar-migration": "pglite",
  "smoke-broadcasts": "pglite",
  "smoke-chat-context": "pglite",
  "smoke-contact-brief": "pglite",
  "smoke-constellation-admin": "pglite",
  "smoke-constellation-payload-leak": "pglite",
  "smoke-constellation-pin": "pglite",
  "smoke-constellation-signals": "pglite",
  "smoke-contact-profile": "pglite",
  "smoke-contacts-page": "pglite", // own in-memory PGlite, but imports the DDL from ../src/db
  "smoke-csp-report": "pglite",
  "smoke-embedding-backfill": "pglite",
  "smoke-embedding-writes": "pglite",
  "smoke-entitlements": "pglite",
  "smoke-health": "pglite",
  "smoke-hybrid-search": "pglite",
  "smoke-import-engine": "pglite",
  "smoke-import-stall": "pglite",
  "smoke-import-resumption-auth": "pglite",
  "smoke-instrumentation": "pglite",
  "smoke-instrumentation-streams": "pglite",
  "smoke-interest-list-admin": "pglite",
  "smoke-internal-auth": "pglite", // imports route handlers that reach @/db
  "smoke-linkedin-direction": "pglite",
  "smoke-linkedin-timeline-backfill": "pglite",
  "smoke-interaction-delete": "pglite",
  "smoke-note-batch": "pglite",
  "smoke-ops-sweep": "pglite",
  "smoke-page-budgets": "pglite",
  "smoke-pgvector-local": "pglite",
  "smoke-presence": "pglite",
  "smoke-purge": "pglite",
  "smoke-rate-limit": "pglite",
  "smoke-recruiter-sharing": "pglite",
  "smoke-schema-upgrade": "pglite",
  "smoke-stripe-webhook": "pglite",
  "smoke-surface-visibility": "pglite",
  "smoke-trigram-search": "pglite",
  "smoke-usage-events": "pglite",
  "smoke-user-settings-race": "pglite",
  "smoke-webhook-guard": "pglite",
  "smoke-write-path": "pglite",
  // manual ----------------------------------------------------------------------------
  "smoke-import-perf": "manual", // wall-clock budgets; run by hand or nightly
};

const TIMEOUT_MS: Partial<Record<string, number>> = {
  "smoke-page-budgets": 5 * 60_000,
  "smoke-import-engine": 5 * 60_000,
};
const DEFAULT_TIMEOUT_MS = 3 * 60_000;

const PREAMBLE_IMPORT = /import\s+"\.\/smoke\/_env"/;
const RAW_DOTENV = /config\(\s*\{\s*path:\s*"\.env\.local"\s*\}\s*\)/;
const DB_IMPORT = /from\s+"\.\.\/src\/db(\/index)?"/;

function scriptsOnDisk(): string[] {
  return readdirSync("scripts")
    .filter((f) => /^smoke-.*\.ts$/.test(f))
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
}

/** The structural guard. Returns problems; empty means safe. */
function check(): string[] {
  const problems: string[] = [];
  const onDisk = scriptsOnDisk();
  for (const name of onDisk) {
    if (!(name in MANIFEST)) problems.push(`${name}: not in the manifest in scripts/run-smoke.ts — assign it a tier`);
  }
  for (const name of Object.keys(MANIFEST)) {
    if (!onDisk.includes(name)) problems.push(`${name}: in the manifest but not on disk`);
  }
  for (const name of onDisk) {
    const src = readFileSync(join("scripts", `${name}.ts`), "utf8");
    const tier = MANIFEST[name];
    const hasPreamble = PREAMBLE_IMPORT.test(src);
    if (RAW_DOTENV.test(src)) {
      problems.push(`${name}: loads .env.local directly — import "./smoke/_env" instead, which also forces PGlite`);
    }
    if ((tier === "pglite" || tier === "manual") && !hasPreamble) {
      problems.push(`${name}: ${tier} tier must start with import "./smoke/_env"`);
    }
    if (tier === "pure" && DB_IMPORT.test(src)) {
      problems.push(`${name}: pure tier imports ../src/db — move it to the pglite tier`);
    }
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const ci = args.includes("--ci");
  const checkOnly = args.includes("--check");
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? args.slice(onlyIdx + 1).filter((a) => !a.startsWith("--")) : null;

  const problems = check();
  if (problems.length > 0) {
    console.error("run-smoke: refusing to run — the suite is not safe as laid out:\n");
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(2);
  }
  console.log(`run-smoke: manifest covers ${Object.keys(MANIFEST).length} scripts; structure ok.`);
  if (checkOnly) process.exit(0);

  const selected = Object.entries(MANIFEST)
    .filter(([name, tier]) => (only ? only.includes(name) : ci ? tier !== "manual" : true))
    .map(([name]) => name);

  // One throwaway PGlite directory for the whole run: the DDL bootstraps once.
  const pgliteDir = mkdtempSync(join(tmpdir(), "orbit-smoke-run-"));
  const env: NodeJS.ProcessEnv = { ...process.env, ORBIT_PGLITE_DIR: pgliteDir, FORCE_COLOR: "0" };
  delete env.DATABASE_URL; // belt and braces; the preamble does this too

  const tsx = join("node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) {
    console.error("run-smoke: node_modules/.bin/tsx not found — run npm ci first.");
    process.exit(2);
  }

  const results: Array<{ name: string; ok: boolean; ms: number; note: string; pending: boolean }> = [];
  for (const name of selected) {
    const started = Date.now();
    const timeout = TIMEOUT_MS[name] ?? DEFAULT_TIMEOUT_MS;
    process.stdout.write(`\n━━━ ${name} (${MANIFEST[name]}) ━━━\n`);
    // stdout stays INHERITED so a long or hanging script prints as it goes — piping it
    // meant nothing appeared until the child exited, which for a hang is not until the
    // timeout fires. Only stderr is piped, and only because the PENDING marker is written
    // there (see below); it is replayed the instant the child exits, so a failing script's
    // stack trace is still shown, just after its stdout rather than interleaved with it.
    const r = spawnSync(tsx, [join("scripts", `${name}.ts`)], {
      env,
      stdio: ["inherit", "inherit", "pipe"],
      timeout,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.stderr) process.stderr.write(r.stderr);
    const ms = Date.now() - started;
    const timedOut = r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    const ok = !timedOut && r.status === 0;

    // A script that degraded rather than fully verified something signals it with a
    // "PENDING: <reason>" line on STDERR — stderr, not stdout, precisely so that stdout can
    // stay inherited and live (see scripts/smoke-contact-profile-format.ts for
    // the first user of this). This is a general runner capability, not special-cased to
    // one script: any smoke script with an environment-dependent gap can use it, and a
    // green exit code alone can no longer read as "fully verified" for that row.
    const pendingReasons = [...(r.stderr ?? "").matchAll(/^PENDING:\s*(.+)$/gm)].map((m) => m[1].trim());
    const pending = ok && pendingReasons.length > 0;

    results.push({
      name,
      ok,
      ms,
      pending,
      note: timedOut
        ? `timed out after ${timeout / 1000}s`
        : r.status !== 0
          ? `exit ${r.status ?? r.signal}`
          : pending
            ? `PENDING: ${pendingReasons.join("; ")}`
            : "",
    });
  }

  const failed = results.filter((r) => !r.ok);
  const pending = results.filter((r) => r.pending);
  console.log("\n" + "═".repeat(72));
  for (const r of results) {
    const label = !r.ok ? "FAIL" : r.pending ? "PEND" : " ok ";
    console.log(`${label}  ${r.name.padEnd(40)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.note}`);
  }
  console.log("═".repeat(72));
  console.log(`${results.length - failed.length}/${results.length} passed in ${(results.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(0)}s`);
  if (pending.length > 0) {
    console.log(
      `${pending.length} script${pending.length === 1 ? "" : "s"} reported PENDING coverage — passing but incomplete; see notes above.`
    );
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
