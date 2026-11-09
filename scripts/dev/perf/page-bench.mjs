/**
 * Page-load benchmark: every route, cold (fresh Chrome profile, empty HTTP cache) and warm
 * (second load in the same browser, cache populated), with Core Web Vitals read in the page.
 *
 *   node scripts/dev/perf/page-bench.mjs <baseUrl> [--profile=desktop|mobile] [--rounds=n]
 *        [--routes=/a,/b] [--json=out.json] [--label=name]
 *
 * Point it at a PRODUCTION build in demo mode (see scripts/dev/perf/README.md). Per load:
 *   ttfb      responseStart (server work before the first byte; streaming pages send the shell)
 *   docEnd    responseEnd (the whole streamed document has arrived)
 *   fcp, lcp  paint timings (LCP is the last candidate seen before the page went quiet)
 *   cls       layout shift, session-window max, input-excluded
 *   tbt       sum of (long task - 50 ms) from FCP to the end of the observation window
 *   hydrated  first time the main thread was free and React had attached to a DOM node
 *   load      loadEventEnd
 *   reqs, kb, jsKb   resource count, transferred KB (0 when served from cache), JS transferred KB
 *
 * Profiles: `desktop` is unthrottled 1440x900; `mobile` is 412x823, 4x CPU slowdown and
 * 150 ms RTT / 1.6 Mbps down (Lighthouse's slow-4G mobile numbers), applied through CDP.
 * Medians over rounds. Run baseline and candidate builds interleaved on the same machine.
 */
import { writeFileSync } from "node:fs";
import { launch } from "../cdp.mjs";

const args = process.argv.slice(2);
const BASE = args.find((a) => !a.startsWith("--")) ?? "http://localhost:4100";
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PROFILE = flag("profile", "desktop");
const ROUNDS = Number(flag("rounds", 3));
const ONLY = flag("routes", "").split(",").filter(Boolean);
const JSON_OUT = flag("json", null);
const LABEL = flag("label", BASE);
const QUIET_MS = Number(flag("quiet", 2500));

const PUBLIC = ["/", "/pricing", "/interest", "/privacy", "/terms", "/contact", "/sign-in"];
const APP = [
  "/dashboard", "/contacts", "@profile", "/contacts/duplicates", "/graph", "/chat", "/capture", "/imports",
  "/knowledge", "/events", "/outreach", "/recruiters", "/reminders", "/meetings", "/settings", "/radar", "/find",
];

const INIT = `(() => {
  const m = (window.__pm = { fcp: null, lcp: 0, cls: 0, long: [], hydrated: null });
  const po = (type, fn) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch {} };
  po("paint", (e) => { if (e.name === "first-contentful-paint") m.fcp = e.startTime; });
  po("largest-contentful-paint", (e) => { m.lcp = e.startTime; });
  let win = 0, first = 0, last = 0;
  po("layout-shift", (e) => {
    if (e.hadRecentInput) return;
    if (win && e.startTime - last < 1000 && e.startTime - first < 5000) win += e.value;
    else { win = e.value; first = e.startTime; }
    last = e.startTime;
    m.cls = Math.max(m.cls, win);
  });
  po("longtask", (e) => m.long.push([e.startTime, e.duration]));
  const iv = setInterval(() => {
    if (m.hydrated !== null) return clearInterval(iv);
    const els = document.body ? document.body.querySelectorAll("main, main *, header, nav, a, button") : [];
    for (let i = 0; i < els.length && i < 80; i++) {
      for (const k in els[i]) if (k.startsWith("__reactProps")) { m.hydrated = performance.now(); return; }
    }
  }, 20);
})()`;

const READ = `(() => {
  const m = window.__pm, nav = performance.getEntriesByType("navigation")[0];
  const res = performance.getEntriesByType("resource");
  const fcp = m.fcp ?? 0;
  const tbt = m.long.filter(([s]) => s >= fcp).reduce((a, [, d]) => a + Math.max(0, d - 50), 0);
  const sum = (xs) => xs.reduce((a, r) => a + (r.transferSize || 0), 0);
  return {
    ttfb: nav.responseStart, docEnd: nav.responseEnd, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd,
    fcp: m.fcp, lcp: m.lcp, cls: m.cls, tbt, hydrated: m.hydrated, longTasks: m.long.length,
    reqs: res.length + 1, kb: (sum(res) + (nav.transferSize || 0)) / 1024,
    jsKb: sum(res.filter((r) => r.name.includes(".js"))) / 1024,
    jsRawKb: res.filter((r) => r.name.includes(".js")).reduce((a, r) => a + (r.decodedBodySize || 0), 0) / 1024,
  };
})()`;

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

async function session() {
  const mobile = PROFILE === "mobile";
  const cdp = await launch(mobile ? { width: 412, height: 823, mobile: true } : { width: 1440, height: 900 });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT });
  await cdp.send("Network.enable");
  if (mobile) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  }
  return cdp;
}

const withDeadline = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} exceeded ${ms} ms`)), ms))]);

function load(cdp, url) {
  return withDeadline(loadInner(cdp, url), 60000, `load ${url}`);
}

async function loadInner(cdp, url) {
  const t0 = Date.now();
  await cdp.goto(url);
  const wall = Date.now() - t0;
  try { await cdp.waitFor(`window.__pm && window.__pm.hydrated !== null`, 25000); } catch {}
  await cdp.sleep(QUIET_MS);
  const r = await cdp.evaluate(READ);
  const finalPath = await cdp.evaluate(`location.pathname`);
  return { ...r, wall, finalPath };
}

async function resolveProfileId() {
  const res = await fetch(`${BASE}/contacts`, { redirect: "follow" });
  const html = await res.text();
  const ids = [...html.matchAll(/\/contacts\/([0-9a-f]{8}-[0-9a-f-]{27})/g)].map((m) => m[1]);
  return ids[0] ?? null;
}

const pid = await resolveProfileId();
const routes = [...PUBLIC, ...APP].filter((r) => (ONLY.length ? ONLY.includes(r) : true));
const out = { label: LABEL, base: BASE, profile: PROFILE, rounds: ROUNDS, profileId: pid, at: new Date().toISOString(), routes: {} };

for (const route of routes) {
  const path = route === "@profile" ? (pid ? `/contacts/${pid}` : null) : route;
  if (!path) continue;
  const key = route === "@profile" ? "/contacts/[id]" : route;
  const cold = [], warm = [];
  for (let i = 0; i < ROUNDS; i++) {
    const cdp = await session();
    try {
      cold.push(await load(cdp, `${BASE}${path}`));
      warm.push(await load(cdp, `${BASE}${path}`));
    } catch (e) {
      console.error(key, "failed:", e.message);
    } finally {
      cdp.close();
    }
  }
  const agg = (rows) => {
    const o = {};
    for (const f of ["ttfb", "docEnd", "fcp", "lcp", "cls", "tbt", "hydrated", "load", "reqs", "kb", "jsKb", "jsRawKb", "longTasks", "wall"]) o[f] = median(rows.map((r) => r[f]));
    o.finalPath = rows[0]?.finalPath;
    return o;
  };
  out.routes[key] = { path, cold: agg(cold), warm: agg(warm), raw: { cold, warm } };
  const c = out.routes[key].cold, w = out.routes[key].warm;
  const f = (x, d = 0) => (x == null ? "  -  " : x.toFixed(d));
  console.log(`${key.padEnd(22)} cold ttfb ${f(c.ttfb).padStart(5)} fcp ${f(c.fcp).padStart(5)} lcp ${f(c.lcp).padStart(5)} hyd ${f(c.hydrated).padStart(5)} tbt ${f(c.tbt).padStart(4)} cls ${f(c.cls, 3)} js ${f(c.jsKb).padStart(4)}K  | warm ttfb ${f(w.ttfb).padStart(5)} lcp ${f(w.lcp).padStart(5)} hyd ${f(w.hydrated).padStart(5)}${c.finalPath !== path ? `  [-> ${c.finalPath}]` : ""}`);
}

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
