/**
 * Search latency as a person feels it, on /contacts: type a query one key at a time, then
 * measure from the LAST keystroke until the list shows that query's results (URL carries the
 * query, the count line matches it, and no skeleton or aria-busy is visible).
 *
 *   node scripts/dev/perf/search-bench.mjs <baseUrl> [--rounds=n] [--keygap=ms] [--json=out]
 *
 * Also reports `renders`: how many RSC requests (`?_rsc=`) the typing caused, and the
 * server-side time of a direct `/contacts?q=` document fetch, for the same queries.
 */
import { writeFileSync } from "node:fs";
import { launch } from "../cdp.mjs";

const args = process.argv.slice(2);
const BASE = args.find((a) => !a.startsWith("--")) ?? "http://localhost:4100";
const flag = (n, d) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const ROUNDS = Number(flag("rounds", 5));
const KEYGAP = Number(flag("keygap", 90));
const JSON_OUT = flag("json", null);
const QUERIES = ["sarah", "engineer at acme", "ai", "zzzz-no-match"];

const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[v.length >> 1] : (v[(v.length >> 1) - 1] + v[v.length >> 1]) / 2) : null; };

const cdp = await launch({ width: 1440, height: 900 });
const rscReqs = [];
await cdp.send("Network.enable");
cdp.onEvent("Network.requestWillBeSent", (p) => { if (p.request.url.includes("_rsc=") || p.request.method === "POST") rscReqs.push(p.request.url); });
await cdp.goto(`${BASE}/contacts`);
await cdp.waitHydrated();
await cdp.sleep(2500);

const out = { base: BASE, keygap: KEYGAP, queries: {} };
for (const q of QUERIES) {
  const settled = [], renders = [];
  for (let r = 0; r < ROUNDS; r++) {
    await cdp.evaluate(`(() => { const i = document.querySelector('input[type="search"], input[placeholder*="earch" i]'); i.focus(); i.select(); })()`);
    await cdp.key("Backspace");
    await cdp.waitFor(`!new URL(location.href).searchParams.get("q") && document.querySelector('input[placeholder*="earch" i]').value === ""`, 8000).catch(() => {});
    await cdp.sleep(1800);
    const before = rscReqs.length;
    await cdp.evaluate(`window.__s = { t: 0, done: null, gen: (window.__gen = (window.__gen || 0) + 1) }; (() => { const gen = window.__s.gen;
      const busy = () => [...document.querySelectorAll('main [data-slot="skeleton"], main [aria-busy="true"]')].some((e) => e.getClientRects().length);
      const tick = () => {
        if (window.__s.gen !== gen) return;
        if (window.__s.t && window.__s.done === null) {
          const ok = new URL(location.href).searchParams.get("q") === ${JSON.stringify(q)} && !busy();
          if (ok) { window.__s.cand = window.__s.cand ?? performance.now(); if (performance.now() - window.__s.cand > 120) window.__s.done = window.__s.cand; }
          else window.__s.cand = null;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })()`);
    for (const ch of q) {
      await cdp.type(ch);
      await cdp.evaluate(`window.__s.t = performance.now()`);
      await cdp.sleep(KEYGAP);
    }
    const t0 = await cdp.evaluate(`window.__s.t`);
    await cdp.waitFor(`window.__s.done !== null`, 15000).catch(() => {});
    const done = await cdp.evaluate(`window.__s.done`);
    if (done === null && process.env.DEBUG) console.log('  stuck:', await cdp.evaluate(`location.search + ' | ' + document.querySelector('input[placeholder*="earch" i]').value + ' | busy=' + document.querySelectorAll('main [data-slot="skeleton"], main [aria-busy="true"]').length`));
    if (done !== null) settled.push(done - t0);
    renders.push(rscReqs.length - before);
  }
  out.queries[q] = { settledMs: median(settled), minMs: Math.min(...settled), maxMs: Math.max(...settled), renders: median(renders), n: settled.length };
  console.log(`${q.padEnd(20)} settled after last key: median ${out.queries[q].settledMs?.toFixed(0)} ms (min ${out.queries[q].minMs.toFixed(0)}, max ${out.queries[q].maxMs.toFixed(0)}), requests while typing: ${out.queries[q].renders}`);
}
cdp.close();

// Server-only: the document fetch for the same queries.
out.server = {};
for (const q of QUERIES) {
  const ts = [];
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    const res = await fetch(`${BASE}/contacts?q=${encodeURIComponent(q)}`);
    await res.text();
    ts.push(performance.now() - t);
  }
  out.server[q] = median(ts.slice(1));
  console.log(`server /contacts?q=${q}: median ${out.server[q].toFixed(0)} ms`);
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
