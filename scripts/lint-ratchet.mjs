#!/usr/bin/env node
/**
 * `npm run lint` (plan P3). Runs ESLint, then enforces two things:
 *
 *   1. No errors.
 *   2. No rule has MORE warnings than `scripts/lint-baseline.json` records for it.
 *
 * A single `--max-warnings N` cannot tell one rule improving from another worsening: fix
 * ten `set-state-in-effect` warnings and the cap silently lets ten new `process.env` reads
 * through. A per-rule baseline can, so a convention can be introduced as a warning at its
 * current count and only ever go down.
 *
 *   npm run lint                    # CI: fail on errors or any rule above its baseline
 *   npm run lint -- --update        # record lower counts after fixing some (never raises)
 *   npm run lint -- --update --allow-increase   # deliberately accept a higher count
 *   npm run lint -- src/lib         # lint a subset (baseline check is skipped)
 *
 * Anything after `--` that is not ours is passed to ESLint as a path/argument.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const BASELINE = new URL("./lint-baseline.json", import.meta.url);
const args = process.argv.slice(2);
const update = args.includes("--update");
const allowIncrease = args.includes("--allow-increase");
const passthrough = args.filter((a) => !["--update", "--allow-increase"].includes(a));
const subset = passthrough.some((a) => !a.startsWith("-"));

const run = spawnSync(
  process.execPath,
  ["node_modules/eslint/bin/eslint.js", ...(subset ? [] : ["."]), ...passthrough, "-f", "json"],
  { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
);
let results;
try {
  results = JSON.parse(run.stdout);
} catch {
  console.error(run.stdout || run.stderr);
  console.error("lint-ratchet: ESLint did not produce JSON output.");
  process.exit(2);
}

const counts = {};
let errors = 0;
for (const file of results) {
  for (const m of file.messages) {
    const rule = m.ruleId ?? "(parse/directive)";
    if (m.severity === 2) {
      errors++;
      console.error(`${file.filePath.replace(process.cwd() + "/", "")}:${m.line}:${m.column}  error  ${m.message}  ${rule}`);
    } else {
      counts[rule] = (counts[rule] ?? 0) + 1;
    }
  }
}
const warnings = Object.values(counts).reduce((a, b) => a + b, 0);

if (errors > 0) {
  console.error(`\nlint-ratchet: ${errors} error(s).`);
  process.exit(1);
}
if (subset) {
  console.log(`lint-ratchet: subset run, ${warnings} warning(s); baseline check skipped.`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const worse = Object.entries(counts).filter(([rule, n]) => n > (baseline[rule] ?? 0));
const better = Object.keys(baseline).filter((rule) => (counts[rule] ?? 0) < baseline[rule]);

if (update) {
  if (worse.length && !allowIncrease) {
    console.error("lint-ratchet: refusing to RAISE a baseline without --allow-increase:");
    for (const [rule, n] of worse) console.error(`  ${rule}: ${baseline[rule] ?? 0} -> ${n}`);
    process.exit(1);
  }
  const next = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n");
  console.log(`lint-ratchet: baseline updated (${warnings} warning(s) across ${Object.keys(next).length} rule(s)).`);
  process.exit(0);
}

if (worse.length) {
  console.error("lint-ratchet: warnings went UP (fix them, or justify with --update --allow-increase):");
  for (const [rule, n] of worse) console.error(`  ${rule}: ${baseline[rule] ?? 0} -> ${n}`);
  process.exit(1);
}
if (better.length) {
  console.log(`lint-ratchet: ${better.length} rule(s) improved; run \`npm run lint -- --update\` to lock it in:`);
  for (const rule of better) console.log(`  ${rule}: ${baseline[rule]} -> ${counts[rule] ?? 0}`);
}
console.log(`lint-ratchet: ok (${warnings} warning(s), 0 errors).`);
