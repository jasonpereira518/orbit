/**
 * Merges per-shard coverage into one report, and prints the numbers that matter.
 *
 * Each CI smoke shard runs under c8 (see .c8rc.json) and keeps only its Istanbul
 * `coverage-final.json` — a few MB — rather than the raw V8 dumps, which run to gigabytes
 * across ~550 processes. This reads every `coverage-final.json` under the given directories,
 * merges them (a line hit on any shard counts), and writes `coverage/merged/` with a JSON
 * summary, an lcov file for tools, and a text table by area.
 *
 * The areas are the risk-ranked ones from docs/TESTING.md, so a drop in, say, `src/lib/api`
 * is visible on its own rather than averaged away across 1,700 files.
 *
 * Run: npx tsx scripts/coverage-merge.ts <dir> [<dir>...]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

/** Path prefixes reported on their own, highest blast radius first. */
const AREAS: Array<[string, string]> = [
  ["auth & access", "src/lib/api/"],
  ["auth & access", "src/lib/auth.ts"],
  ["auth & access", "src/lib/admin.ts"],
  ["auth & access", "src/lib/extension/"],
  ["auth & access", "src/lib/internal-auth.ts"],
  ["auth & access", "src/proxy.ts"],
  ["billing", "src/lib/billing-"],
  ["billing", "src/lib/stripe-"],
  ["billing", "src/lib/entitlements.ts"],
  ["billing", "src/lib/credits/"],
  ["connectors & sync", "src/lib/connectors/"],
  ["connectors & sync", "src/lib/gmail.ts"],
  ["connectors & sync", "src/lib/outlook.ts"],
  ["connectors & sync", "src/lib/caldav/"],
  ["connectors & sync", "src/lib/cloud-files.ts"],
  ["connectors & sync", "src/lib/drive.ts"],
  ["AI", "src/lib/ai"],
  ["AI", "src/lib/relationship-engine/"],
  ["contacts", "src/lib/contact-"],
  ["contacts", "src/lib/duplicates.ts"],
  ["exports", "src/lib/data-export.ts"],
  ["exports", "src/lib/settings-export.ts"],
  ["server actions", "src/actions/"],
  ["API routes", "src/app/api/"],
  ["lib (all)", "src/lib/"],
  ["UI components", "src/components/"],
];

function findReports(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) findReports(path, out);
    else if (entry === "coverage-final.json") out.push(path);
  }
  return out;
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("coverage-merge: pass the directories holding each shard's coverage-final.json");
  process.exit(2);
}
const files = dirs.flatMap((d) => findReports(d));
if (files.length === 0) {
  console.error(`coverage-merge: no coverage-final.json under ${dirs.join(", ")}`);
  process.exit(1);
}

const map = libCoverage.createCoverageMap({});
for (const file of files) map.merge(JSON.parse(readFileSync(file, "utf8")));

const root = process.cwd();
const outDir = join(root, "coverage", "merged");
mkdirSync(outDir, { recursive: true });
const context = libReport.createContext({ dir: outDir, coverageMap: map });
for (const name of ["json-summary", "lcovonly", "text-summary"] as const) {
  reports.create(name).execute(context);
}

type Totals = { lines: [number, number]; functions: [number, number]; files: number; untouched: number };
const byArea = new Map<string, Totals>();
for (const file of map.files()) {
  const rel = relative(root, file).split("\\").join("/");
  const summary = map.fileCoverageFor(file).toSummary();
  for (const [area, prefix] of AREAS) {
    if (!rel.startsWith(prefix)) continue;
    const t = byArea.get(area) ?? { lines: [0, 0], functions: [0, 0], files: 0, untouched: 0 };
    t.lines[0] += summary.lines.covered;
    t.lines[1] += summary.lines.total;
    t.functions[0] += summary.functions.covered;
    t.functions[1] += summary.functions.total;
    t.files += 1;
    if (summary.lines.covered === 0 && summary.lines.total > 0) t.untouched += 1;
    byArea.set(area, t);
  }
}

const pct = ([covered, total]: [number, number]) => (total === 0 ? "  n/a " : `${((100 * covered) / total).toFixed(1).padStart(5)}%`);
const rows = [...new Set(AREAS.map(([a]) => a))].map((area) => {
  const t = byArea.get(area);
  return t
    ? `${area.padEnd(20)} lines ${pct(t.lines)}   functions ${pct(t.functions)}   ${String(t.files).padStart(4)} files, ${t.untouched} never loaded or run`
    : `${area.padEnd(20)} (no files)`;
});
const table = [`Coverage by area (merged from ${files.length} shard report${files.length === 1 ? "" : "s"})`, ...rows].join("\n");
console.log(`\n${table}`);
writeFileSync(join(outDir, "by-area.txt"), `${table}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Smoke-suite coverage\n\n\`\`\`\n${table}\n\`\`\`\n`, { flag: "a" });
}
