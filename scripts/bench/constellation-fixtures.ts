/**
 * Write the constellation bench's network fixtures: `buildSyntheticGraphPayload(n, { seed })` as
 * JSON, one file per size, into `.bench-data/` (gitignored). `serve-static-bench.mjs` serves them
 * at `/bench-data/…`, and the bench page fetches one under `?data=fetch` — so opening the chart
 * in the benchmark pays for a real transfer and parse, as the real page does for its payload.
 *
 *   npx tsx scripts/bench/constellation-fixtures.ts [sizes=100,1000,5000,10000] [--seed 1]
 *
 * Deterministic: the same size and seed write the same bytes on every run and branch.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSyntheticGraphPayload } from "../../src/lib/graph/synthetic-network";

const args = process.argv.slice(2);
const seedIdx = args.indexOf("--seed");
const seed = seedIdx >= 0 ? Number(args[seedIdx + 1]) : 1;
const sizeArg = args.find((a, i) => /^\d[\d,]*$/.test(a) && (seedIdx < 0 || i !== seedIdx + 1));
const sizes = (sizeArg ?? "100,1000,5000,10000").split(",").map(Number);

const dir = join(import.meta.dirname, "../../.bench-data");
mkdirSync(dir, { recursive: true });
for (const n of sizes) {
  const file = join(dir, `constellation-${n}-${seed}.json`);
  const body = JSON.stringify(buildSyntheticGraphPayload(n, { seed }));
  writeFileSync(file, body);
  console.log(`${file} (${(body.length / 1024).toFixed(0)} KB)`);
}
process.exit(0);
