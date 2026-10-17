#!/usr/bin/env node
/**
 * Which smoke scripts read repo files by path (plan P0.5)? Those break when a file moves, so
 * P7/P8 consult `scripts/smoke/source-readers.json` to know which tests move with which file.
 *
 *   node scripts/list-source-readers.mjs            # check the committed manifest is current
 *   node scripts/list-source-readers.mjs --update   # rewrite it
 *
 * Heuristic: a smoke that calls readFileSync/readdirSync/readFile and mentions "src/…" or
 * "scripts/…" path literals. Paths are the literals it names, which is what a rename would
 * have to touch; the list is a superset guide, not proof.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const MANIFEST = new URL("./smoke/source-readers.json", import.meta.url);
const files = readdirSync(new URL("./", import.meta.url))
  .filter((f) => /^smoke-.*\.ts$/.test(f))
  .sort();

const result = {};
for (const file of files) {
  const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  if (!/\b(readFileSync|readdirSync|readFile|readdir|globSync)\b/.test(src)) continue;
  const paths = new Set();
  for (const m of src.matchAll(/["'`]((?:src|scripts|docs|e2e|extension|public)\/[A-Za-z0-9_@()[\].\-/]+)["'`]/g)) {
    paths.add(m[1]);
  }
  if (paths.size) result[file] = [...paths].sort();
}

const next = JSON.stringify(result, null, 2) + "\n";
if (process.argv.includes("--update")) {
  writeFileSync(MANIFEST, next);
  console.log(`source-readers: ${Object.keys(result).length} smoke(s) recorded.`);
} else {
  let current = "";
  try { current = readFileSync(MANIFEST, "utf8"); } catch {}
  if (current !== next) {
    console.error("source-readers: scripts/smoke/source-readers.json is out of date. Run with --update.");
    process.exit(1);
  }
  console.log(`source-readers: ok (${Object.keys(result).length} smokes).`);
}
