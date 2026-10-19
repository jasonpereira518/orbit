/**
 * Expand/contract for the schema sweep. A deploy migrates the database BEFORE the previous
 * deployment stops serving, and an instant rollback leaves the newer schema under older code,
 * so a DROP TABLE / DROP COLUMN must ship a release AFTER the code that stops using the thing
 * (v170 dropped guest_profiles in the same release that removed its readers).
 *
 * Every such statement in src/db/index.ts must be either on the baseline below (what already
 * shipped, plus the two derived generated columns the sweep rebuilds under a guard) or carry a
 * `contract-of: v<N>` comment in the three lines above it, naming an EARLIER schema version in
 * which the last reader was removed.
 *
 * Run: npx tsx scripts/smoke-ddl-contract.ts
 */
import "./smoke/_env";
import { readFileSync } from "node:fs";
import { SCHEMA_VERSION } from "../src/db";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Already shipped or guarded; adding to this list is a review decision, not a convenience. */
const BASELINE = new Set([
  "ALTER TABLE contacts DROP COLUMN IF EXISTS linkedin_slug", // derived; rebuilt only when its expression changes
  "ALTER TABLE contacts DROP COLUMN IF EXISTS search_tsv", // derived; rebuilt only when its expression changes
  "ALTER TABLE user_settings DROP COLUMN IF EXISTS wispr_api_key_encrypted",
  "DROP TABLE IF EXISTS guest_profiles",
  "ALTER TABLE user_settings DROP COLUMN IF EXISTS radar_apollo_cursor",
]);

const source = readFileSync("src/db/index.ts", "utf8").split("\n");
const found: Array<{ line: number; statement: string; above: string }> = [];
source.forEach((text, i) => {
  const m = /^\s*`((?:ALTER TABLE \w+ DROP COLUMN|DROP TABLE)[^`]*)`,/.exec(text);
  if (m) found.push({ line: i + 1, statement: m[1]!.trim(), above: source.slice(Math.max(0, i - 3), i).join("\n") });
});

console.log(`${found.length} DROP TABLE / DROP COLUMN statement(s) in the sweep`);
check("the scan finds the known baseline", found.length >= BASELINE.size, String(found.length));
for (const f of found) {
  if (BASELINE.has(f.statement)) continue;
  const marker = /contract-of:\s*v(\d+)/.exec(f.above);
  check(
    `line ${f.line}: ${f.statement}`,
    Boolean(marker) && Number(marker![1]) < SCHEMA_VERSION,
    "add `// contract-of: v<N>` (an earlier schema version whose release removed the last reader) above it"
  );
}
check("every baseline entry still exists (remove stale ones)",
  [...BASELINE].every((b) => found.some((f) => f.statement === b)));

console.log(failures === 0 ? "\nAll DDL-contract checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
