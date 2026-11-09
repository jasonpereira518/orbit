/**
 * Before/after table from page-bench.mjs outputs. Each side may be several files (interleaved
 * runs); a route's number is the median across the files' per-route medians.
 *
 *   node scripts/dev/perf/compare.mjs --before a1.json,a2.json --after b1.json,b2.json [--md out.md]
 */
import { readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const load = (list) => list.split(",").map((f) => JSON.parse(readFileSync(f, "utf8")));
const before = load(args.before), after = load(args.after);

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[v.length >> 1] : (v[(v.length >> 1) - 1] + v[v.length >> 1]) / 2;
};
const pick = (runs, route, phase, field) => median(runs.map((r) => r.routes[route]?.[phase]?.[field]));
const pct = (b, a) => (b == null || a == null || b === 0 ? "" : `${(((a - b) / b) * 100).toFixed(0)}%`);
const f = (x, d = 0) => (x == null ? "-" : x.toFixed(d));

const routes = Object.keys(before[0].routes).filter((r) => !["/sign-in", "/imports"].includes(r));
const cols = [
  ["cold", "fcp", "FCP", 0], ["cold", "lcp", "LCP", 0], ["cold", "hydrated", "Interactive", 0],
  ["cold", "tbt", "TBT", 0], ["cold", "jsKb", "JS KB gz", 0], ["warm", "lcp", "Warm LCP", 0], ["warm", "hydrated", "Warm interactive", 0],
];
let md = `| Route | ${cols.map((c) => `${c[2]} before → after (Δ)`).join(" | ")} |\n|---|${cols.map(() => "---").join("|")}|\n`;
const totals = cols.map(() => ({ b: [], a: [] }));
for (const route of routes) {
  const cells = cols.map(([phase, field, , d], i) => {
    const b = pick(before, route, phase, field), a = pick(after, route, phase, field);
    if (b != null) totals[i].b.push(b);
    if (a != null) totals[i].a.push(a);
    return `${f(b, d)} → ${f(a, d)} (${pct(b, a) || "–"})`;
  });
  md += `| ${route} | ${cells.join(" | ")} |\n`;
}
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
md += `| **Σ all routes** | ${cols.map((_, i) => `${f(sum(totals[i].b))} → ${f(sum(totals[i].a))} (${pct(sum(totals[i].b), sum(totals[i].a))})`).join(" | ")} |\n`;
console.log(`before: ${before.map((r) => r.label).join(", ")}\nafter:  ${after.map((r) => r.label).join(", ")}\n`);
console.log(md);
if (args.md) writeFileSync(args.md, md);
