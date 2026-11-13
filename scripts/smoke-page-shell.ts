/**
 * A ratchet on design drift in the signed-in app (docs/brand.md has the decisions it protects).
 *
 * Three things are counted per file, and none of the counts may go up:
 *   palette — a colour class that names a stock Tailwind hue and a numeric step, instead of
 *             a token (`primary`, `warning`, `muted-foreground`, …).
 *   hex     — a colour class with a hex value in square brackets.
 *   font    — the long arbitrary-value spelling of the display font (`font-heading` is the
 *             short one).
 *
 * The counts as of the day this landed are in smoke-page-shell.baseline.json. A file fails
 * when any count is above its baseline; a file that is not in the baseline starts at zero.
 * Going down always passes: run with `--update` to lock the lower number in.
 *
 * Counted over the syntax tree, string literals only, so a class in a comment does not count.
 * The patterns below are assembled from fragments because Tailwind scans this folder for
 * class names and would otherwise emit CSS for the very classes this script looks for.
 *
 * Out of scope: the always-dark marketing surfaces (landing, interest, marketing, pricing)
 * and files that hold other companies' brand colours.
 *
 * Pure: parses source with the TypeScript compiler, touches no database.
 * Run:    npx tsx scripts/smoke-page-shell.ts
 * Update: npx tsx scripts/smoke-page-shell.ts --update
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOTS = ["src/app/(clerk)/(app)", "src/components"];
const SKIP = [
  /^src\/components\/(landing|interest|marketing|pricing)\//,
  /brand-colors\.tsx?$/, // other companies' colours, kept as data
];
const BASELINE = "scripts/smoke-page-shell.baseline.json";

const HUES = [
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow", "lime", "green",
  "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
];
const PALETTE = new RegExp(`-(?:${HUES.join("|")})-(?:50|[1-9]00|950)(?![\\w-])`, "g");
const HEX = new RegExp(["-", "\\[", "#", "[0-9a-fA-F]{3,8}", "\\]"].join(""), "g");
const FONT = new RegExp(["font-", "\\[", "family-name:", "var\\(--font-display\\)", "\\]"].join(""), "g");

type Counts = { palette: number; hex: number; font: number };
const KINDS = ["palette", "hex", "font"] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

function count(file: string, text: string): Counts {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const counts: Counts = { palette: 0, hex: 0, font: 0 };
  const add = (s: string) => {
    counts.palette += s.match(PALETTE)?.length ?? 0;
    counts.hex += s.match(HEX)?.length ?? 0;
    counts.font += s.match(FONT)?.length ?? 0;
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node.text);
    else if (ts.isTemplateExpression(node)) {
      add(node.head.text);
      for (const span of node.templateSpans) add(span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return counts;
}

// The guard guards itself: one of each, a comment that must not count, a token that must not.
{
  const hue = ["bg", "amber", "500"].join("-");
  const hex = ["text-", "[", "#0a0b0c", "]"].join("");
  const font = ["font-", "[", "family-name:var(--font-display)", "]"].join("");
  const got = count(
    "fixture.tsx",
    `// ${hue}\nexport default () => <p className={cn("${hue}/20 hover:${hue} ${hex}", on && \`${font} \${x}\`)}>bg-primary</p>;`
  );
  if (got.palette !== 2 || got.hex !== 1 || got.font !== 1) {
    console.error(`FAIL self-check: expected 2/1/1, counted ${got.palette}/${got.hex}/${got.font}`);
    process.exit(1);
  }
}

const current: Record<string, Counts> = {};
for (const root of ROOTS) {
  for (const file of walk(root).sort()) {
    if (SKIP.some((re) => re.test(file))) continue;
    const counts = count(file, readFileSync(file, "utf8"));
    if (counts.palette + counts.hex + counts.font > 0) current[file] = counts;
  }
}

const total = (kind: (typeof KINDS)[number]) => Object.values(current).reduce((n, c) => n + c[kind], 0);
const summary = `${Object.keys(current).length} files — ${KINDS.map((k) => `${total(k)} ${k}`).join(", ")}`;

if (process.argv.includes("--update")) {
  // One file per line: later PRs rewrite many entries, and a line each keeps the diff readable.
  const lines = Object.entries(current).map(([file, c]) => `  ${JSON.stringify(file)}: ${JSON.stringify(c)}`);
  writeFileSync(BASELINE, `{\n${lines.join(",\n")}\n}\n`);
  console.log(`page shell — baseline written: ${summary}`);
  process.exit(0);
}

const baseline: Record<string, Counts> = JSON.parse(readFileSync(BASELINE, "utf8"));
const zero: Counts = { palette: 0, hex: 0, font: 0 };
let failures = 0;
let improved = 0;
for (const [file, counts] of Object.entries(current)) {
  const was = baseline[file] ?? zero;
  for (const kind of KINDS) {
    if (counts[kind] > was[kind]) {
      failures += 1;
      console.error(`  FAIL ${file}: ${kind} ${was[kind]} → ${counts[kind]}`);
    }
  }
}
for (const [file, was] of Object.entries(baseline)) {
  const now = current[file] ?? zero;
  if (KINDS.some((kind) => now[kind] < was[kind])) improved += 1;
}

console.log(`page shell — ${summary}`);
if (failures > 0) {
  console.error(
    `\n${failures} count(s) went up. Use a token instead (see docs/brand.md). If the new class is` +
      ` deliberate, run: npx tsx scripts/smoke-page-shell.ts --update`
  );
  process.exit(1);
}
if (improved > 0) {
  console.log(`${improved} file(s) are below baseline — lock that in: npx tsx scripts/smoke-page-shell.ts --update`);
}
console.log("no count went up");
process.exit(0);
