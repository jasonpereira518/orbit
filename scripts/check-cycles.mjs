#!/usr/bin/env node
/**
 * Ratchet for circular imports (plan P0.5). Runs madge with type-only imports skipped
 * (`.madgerc`) and fails when a cycle appears that is not in `scripts/cycles.baseline.json`.
 * A cycle that disappears is good news: re-run with `--update` to shrink the baseline.
 *
 *   npm run check:cycles            # CI
 *   npm run check:cycles -- --update
 *
 * madge is pinned here rather than added to package.json so the lockfile stays untouched.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MADGE = "madge@8.0.0";
const BASELINE = new URL("./cycles.baseline.json", import.meta.url);
const update = process.argv.includes("--update");

// madge exits 1 when it finds cycles; the JSON is still on stdout.
let out;
try {
  out = execFileSync("npx", ["--yes", MADGE, "--circular", "--json", "src"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch (err) {
  out = err.stdout;
  if (typeof out !== "string" || !out.trim().startsWith("[")) throw err;
}
// Normalise each cycle so rotation of the same loop compares equal.
const key = (cycle) => {
  const i = cycle.indexOf([...cycle].sort()[0]);
  return [...cycle.slice(i), ...cycle.slice(0, i)].join(" > ");
};
const found = JSON.parse(out).map(key).sort();

if (update) {
  writeFileSync(BASELINE, JSON.stringify(found, null, 2) + "\n");
  console.log(`check-cycles: baseline updated, ${found.length} cycle(s).`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const added = found.filter((c) => !baseline.includes(c));
const removed = baseline.filter((c) => !found.includes(c));

if (added.length) {
  console.error(`check-cycles: ${added.length} NEW circular import(s):`);
  for (const c of added) console.error(`  ${c}`);
  process.exit(1);
}
if (removed.length) {
  console.log(`check-cycles: ${removed.length} cycle(s) gone. Run \`npm run check:cycles -- --update\` to lock that in.`);
}
console.log(`check-cycles: ok (${found.length} known cycle(s), baseline ${baseline.length}).`);
