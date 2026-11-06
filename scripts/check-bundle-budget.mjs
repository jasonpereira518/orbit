/**
 * Fails when a finished `next build` ships more first-load weight than the budget allows.
 *
 *   npm run build && node scripts/check-bundle-budget.mjs
 *
 * Reads the per-route numbers `scripts/dev/bundle-report.mjs` computes (entry JS gzipped,
 * preloaded fonts) and checks them against the ceilings below. The ceilings sit just above
 * today's numbers (LATENCY_BASELINE.md, 2026-10-17, after the font fix): they stop a
 * regression, and each improvement should lower them. LATENCY_PLAN.md §3 has the targets
 * (≤ 300 KB per app page, ≤ 220 KB floor) these ratchet toward.
 *
 * The framework root chunks and clerk-js are outside these numbers: the report's
 * `app_js_gz_kb` column. Its `js_gz_kb` is the full first load, framework included
 * (~100 KB gz more on every route), which is what a visitor downloads but not what an app
 * change moves.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Entry JS, gzipped KB, for any non-admin route. Today's heaviest: /contacts/[id] at 382. */
const MAX_ROUTE_JS_GZ_KB = 400;
/** The marketing pages ship no app shell. Today's heaviest: /pricing at 181. */
const MAX_MARKETING_JS_GZ_KB = 200;
const MARKETING = new Set(["/", "/pricing", "/upgrade", "/interest"]);
/** Preloaded fonts per route: Outfit + Fraunces upright (Fraunces italic is not preloaded). */
const MAX_PRELOADED_FONTS = 2;
const MAX_FONT_KB = 70;

const out = join(mkdtempSync(join(tmpdir(), "bundle-budget-")), "report.json");
execFileSync(process.execPath, ["scripts/dev/bundle-report.mjs", "--json", out], { stdio: ["ignore", "ignore", "inherit"] });
const rows = JSON.parse(readFileSync(out, "utf8"));

const failures = [];
for (const r of rows) {
  if (r.route.startsWith("/admin")) continue;
  const jsMax = MARKETING.has(r.route) ? MAX_MARKETING_JS_GZ_KB : MAX_ROUTE_JS_GZ_KB;
  if (r.app_js_gz_kb > jsMax) failures.push(`${r.route}: ${r.app_js_gz_kb} KB gz of first-load app JS (budget ${jsMax})`);
  if (r.fonts > MAX_PRELOADED_FONTS) failures.push(`${r.route}: ${r.fonts} preloaded fonts (budget ${MAX_PRELOADED_FONTS})`);
  if (r.font_kb > MAX_FONT_KB) failures.push(`${r.route}: ${r.font_kb} KB of preloaded fonts (budget ${MAX_FONT_KB})`);
}

const checked = rows.filter((r) => !r.route.startsWith("/admin"));
// API routes have no client JS, so no app column: count them as 0 rather than sort on NaN.
const heaviest = [...checked].sort((a, b) => (b.app_js_gz_kb ?? 0) - (a.app_js_gz_kb ?? 0))[0];
console.log(`${checked.length} routes checked; heaviest app first load ${heaviest?.route} at ${heaviest?.app_js_gz_kb} KB gz (${heaviest?.js_gz_kb} with the framework).`);
if (failures.length) {
  console.error(`\nOver budget:\n  ${failures.join("\n  ")}\n\nIf the growth is intended, raise the ceiling in scripts/check-bundle-budget.mjs and say why in the commit.`);
  process.exit(1);
}
console.log("Bundle budget: ok.");
