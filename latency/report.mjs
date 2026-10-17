/**
 * Turn one results directory into Markdown tables (what LATENCY_BASELINE.md is built from).
 *
 *   node latency/report.mjs latency/results/baseline > latency/results/baseline/REPORT.md
 *   node latency/report.mjs latency/results/baseline latency/results/after   # before/after columns
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dirs = process.argv.slice(2);
if (!dirs.length) { console.error("usage: node latency/report.mjs <results-dir> [<compare-dir>]"); process.exit(1); }
const read = (dir, name) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null);
const files = (dir, prefix) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).sort() : []);
const fmt = (v) => (v == null || Number.isNaN(v) ? "–" : typeof v === "number" ? String(v) : String(v));
const table = (headers, rows) => [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(fmt).join(" | ")} |`)].join("\n");
const out = [];
const h = (s) => out.push(`\n## ${s}\n`);

const [base, cmp] = dirs;
out.push(`# Latency results: ${base}${cmp ? ` vs ${cmp}` : ""}\n`);

// ---- bundle ----
const bundle = read(base, "bundle-report.json");
if (bundle) {
  h("Client JS per route (first load, from the production build)");
  const main = bundle.filter((r) => !r.route.startsWith("/admin") && !r.route.startsWith("/api") && !r.route.startsWith("/bench")).sort((a, b) => b.js_gz_kb - a.js_gz_kb);
  out.push(table(["route", "js raw KB", "js gz KB", "fonts KB", "server KB"], main.map((r) => [r.route, r.js_kb, r.js_gz_kb, r.font_kb, r.server_kb])));
  out.push("\nNote: excludes the ~439 KB raw / ~130 KB gz framework root chunks every page also loads, lazy chunks, clerk-js from Clerk's CDN (~775 KB), and CSS.");
}
const cold = read(base, "cold-start-report.json");
if (cold) {
  h("Server cold start: module evaluation per route (fresh Node process, no I/O)");
  const rows = cold.filter((r) => !r.error && r.totalMs != null).sort((a, b) => b.totalMs - a.totalMs).slice(0, 25);
  out.push(table(["route", "total ms", "require", "tree", "ssr", "eager KB"], rows.map((r) => [r.route, r.totalMs, r.requireMs, r.treeMs, r.ssrMs, r.eagerKB])));
  const errs = cold.filter((r) => r.error).length;
  if (errs) out.push(`\n${errs} route handlers could not be timed by scripts/dev/cold-start-report.mjs (Next 16.3 lazy route modules); their eager KB is in the JSON.`);
}

// ---- server ops ----
for (const f of files(base, "server-ops-")) {
  const r = read(base, f); const c = cmp ? read(cmp, f) : null;
  h(`Server ops, tier ${r.tier} (in-process; depth = sequential round trips at ${r.latencyMs} ms/statement)`);
  const by = (rows) => Object.fromEntries((rows ?? []).map((x) => [x.op, x]));
  const cm = by(c?.rows);
  out.push(table(
    ["op", "group", "stmts", "depth", "cpu ms", "KB", "est ms @8ms RTT", "est ms @40ms RTT", ...(cmp ? ["after stmts", "after depth", "after cpu"] : [])],
    r.rows.map((x) => [x.op, x.group, x.error ? `ERR ${x.error.slice(0, 40)}` : x.statements, x.depth, x.cpu_ms, x.kb, x.est_ms_rtt8, x.est_ms_rtt40, ...(cmp ? [cm[x.op]?.statements, cm[x.op]?.depth, cm[x.op]?.cpu_ms] : [])])
  ));
}

// ---- pages ----
for (const f of files(base, "pages-")) {
  const r = read(base, f);
  for (const [profile, res] of Object.entries(r.results)) {
    h(`Pages, ${f.replace("pages-", "tier ").replace(".json", "")}, ${profile} (${profile === "mobile4g" ? "4G 150 ms RTT, 4x CPU slowdown" : "unthrottled"}; next dev demo mode, median of ${res.rounds})`);
    out.push(table(
      ["page", "TTFB", "FCP", "LCP", "usable", "INP", "CLS", "TBT", "JS gz KB", "requests", "repeat TTFB", "repeat usable", "repeat JS KB"],
      Object.entries(res.pages).map(([k, p]) => [k, p.cold?.ttfb, p.cold?.fcp, p.cold?.lcp, p.cold?.usable, p.cold?.inp, p.cold?.cls, p.cold?.tbt, p.cold?.js_kb, p.cold?.requests, p.repeat?.ttfb, p.repeat?.usable, p.repeat?.js_kb])
    ));
    if (res.nav?.length) {
      out.push(`\nClient-side navigation (sidebar click → URL changed and no skeleton), ${profile}:\n`);
      out.push(table(["to", "ms", "skeleton shown at"], res.nav.map((n) => [n.to, n.ms ?? (n.missing_link ? "no link" : "timeout"), n.skeleton_ms])));
      out.push(`\nHistory: back ${fmt(res.history?.back?.ms)} ms, forward ${fmt(res.history?.forward?.ms)} ms.`);
    }
  }
}

// ---- api ----
for (const f of files(base, "api-")) {
  const r = read(base, f);
  h(`HTTP routes and documents, ${f.replace("api-", "tier ").replace(".json", "")} (n=${r.n} sequential, then ${r.concurrency} concurrent; next dev)`);
  out.push(table(
    ["target", "status", "KB", "single p50", "p95", "p99", "ttfb p50", "conc p50", "conc p95", "conc p99"],
    Object.entries(r.results).map(([k, v]) => [k, v.single.status, v.single.kb, v.single.p50, v.single.p95, v.single.p99, v.single.ttfb_p50, v.concurrent.p50, v.concurrent.p95, v.concurrent.p99])
  ));
}

// ---- ai ----
for (const f of files(base, "ai-")) {
  const r = read(base, f);
  h(`AI paths, ${f.replace("ai-", "tier ").replace(".json", "")} (mock provider: ${JSON.stringify(r.mock?.delays ?? {})})`);
  out.push(table(["chat question", "headers p50", "first token p50", "complete p50", "statements"], Object.entries(r.chat ?? {}).map(([k, v]) => [`${k}: ${v.question}`, v.headers_p50, v.first_token_p50, v.complete_p50, v.statements_p50])));
  const steps = Object.values(r.chat ?? {})[0]?.runs?.find((x) => x.steps)?.steps;
  if (steps?.length) out.push(`\nStage timeline of one open question (ms after request): ${steps.map((s) => `${s.at} ${s.step}`).join("; ")}`);
  if (r.capture) out.push(`\nCapture (paste ${r.capture.notes_chars} chars → reviewed): p50 ${fmt(r.capture.reviewed_p50)} ms; runs: ${r.capture.runs.map((x) => x.reviewed_ms ?? x.error).join(", ")}`);
}

// ---- import ----
for (const f of files(base, "import-")) {
  const r = read(base, f);
  h(`LinkedIn import, ${f.replace("import-", "tier ").replace(".json", "")} (${r.rows} rows, ${r.csv_kb} KB CSV, network of ${r.network_before})`);
  out.push(table(["phase", "ms", "first progress ms", "rows/s", "statements"], [
    ["stage (parse + write rows)", r.stage.stage_ms, "–", "–", r.stage.statements],
    ["run: all creates", r.create.run_ms, r.create.first_progress_ms, r.create.rows_per_s, r.create.statements],
    ["stage again", r.stage_again.stage_ms, "–", "–", r.stage_again.statements],
    ["run: all merges", r.merge.run_ms, r.merge.first_progress_ms, r.merge.rows_per_s, r.merge.statements],
  ]));
}

// ---- constellation ----
const graph = read(base, "constellation.json");
if (graph) {
  h("Constellation (/bench/constellation, static production build)");
  out.push(table(["n", "profile", "payload KB", "ready ms", "long tasks ms", "idle fps", "pan fps", "pan p95 frame", "zoom fps", "nodes", "heap MB"], graph.rows.map((x) => [x.n, x.profile, x.fetch_kb, x.ready_ms, x.long_tasks_ms, x.idle_fps, x.pan_fps, x.pan_p95_frame_ms, x.zoom_fps, x.nodes, x.heap_mb ?? x.error])));
}

console.log(out.join("\n"));
