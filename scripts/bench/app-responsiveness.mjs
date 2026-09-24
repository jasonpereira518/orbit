/**
 * Does having opened the Constellation make the REST of the app slower?
 *
 * Tours the same non-graph pages by real client-side navigation (clicking the sidebar, as a
 * person would — one document, so anything the graph left behind is still there) and measures
 * each page: navigation time, main-thread busy share while sitting idle, rAF callbacks a second
 * (is something still animating?), server-action POSTs (is something still fetching?), scroll
 * frame rate, heap after GC, DOM nodes and listeners.
 *
 * Scenarios, each in a fresh browser:
 *   never    — the tour, having never opened /graph
 *   opened   — open /graph, pan / zoom / hover it, leave, then the tour
 *   refresh  — as `opened`, but press the chart's Refresh before leaving
 *
 *   node scripts/bench/app-responsiveness.mjs http://localhost:3002 [never,opened,refresh] [--out f.json]
 *
 * Runs against a demo-mode dev server (no Clerk), because a local production build without
 * Clerk keys serves nothing (src/proxy.ts). Absolute numbers are dev-build numbers; the
 * comparison between scenarios is what this measures.
 */
import { writeFileSync } from "node:fs";
import { launch } from "../dev/cdp.mjs";

const argv = process.argv.slice(2);
const base = argv.find((a) => a.startsWith("http")) ?? "http://localhost:3002";
const scenarios = (argv.find((a) => /^[a-z,]+$/.test(a)) ?? "never,opened,refresh").split(",");
const outIdx = argv.indexOf("--out");
const out = outIdx >= 0 ? argv[outIdx + 1] : null;
const TOUR = ["/contacts", "/reminders", "/events", "/outreach", "/imports", "/settings"];

/** Installed before the app runs, and alive for the whole document. */
const PRELUDE = `
window.__probe = { raf: 0, actions: 0, actionUrls: {}, lt: [] };
const _raf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (cb) => { window.__probe.raf++; return _raf(cb); };
const _fetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const h = init && init.headers;
  const isAction = h && (h instanceof Headers ? h.has("next-action") : Object.keys(h).some((k) => k.toLowerCase() === "next-action"));
  if (isAction) { window.__probe.actions++; const u = String(typeof input === "string" ? input : input.url); window.__probe.actionUrls[u] = (window.__probe.actionUrls[u] || 0) + 1; }
  return _fetch(input, init);
};
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__probe.lt.push({ s: e.startTime, d: e.duration }); }).observe({ type: "longtask", buffered: true }); } catch {}
`;

async function taskSeconds(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const get = (n) => metrics.find((m) => m.name === n)?.value ?? 0;
  return { task: get("TaskDuration"), heap: get("JSHeapUsedSize"), nodes: get("Nodes"), listeners: get("JSEventListeners") };
}

async function gc(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.sleep(250);
  await cdp.send("HeapProfiler.collectGarbage");
}

/**
 * Click the sidebar link for `href` and wait until the page has real content.
 *
 * A page that never arrives is the symptom under test, not a reason to abandon the run: the
 * orphaned Refresh loop made /contacts take longer than a minute. So a timeout is recorded as
 * the number it is (`>120000`) and the tour carries on.
 */
async function navigate(cdp, href) {
  const t0 = await cdp.evaluate("performance.now()");
  await cdp.evaluate(`(() => { const a = [...document.querySelectorAll('a[href="${href}"]')].find((el) => el.getBoundingClientRect().width > 0); if (!a) throw new Error("no link ${href}"); a.click(); })()`);
  try {
    await cdp.waitFor(
      `location.pathname === "${href}" && (document.querySelector("main")?.innerText.length ?? 0) > 120 && !document.querySelector("main [data-slot=skeleton], main .animate-pulse")`,
      120_000
    );
  } catch {
    return -1;
  }
  // Two frames: the content is not "shown" until it has painted.
  return cdp.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(Math.round(performance.now() - ${t0})))))`);
}

/** Frame rate of a 1.2s scripted scroll of <main> (the app's scroller). */
const SCROLL_FPS = `new Promise((res) => {
  const main = document.querySelector("main");
  if (!main) return res({ fps: null, worst: null });
  const ts = []; const t0 = performance.now();
  (function f(t) { ts.push(t); main.scrollTop = ((t - t0) / 1200) * Math.max(0, main.scrollHeight - main.clientHeight); if (t - t0 < 1200) requestAnimationFrame(f); else { main.scrollTop = 0; const d = ts.slice(1).map((x, i) => x - ts[i]); res({ fps: Math.round((d.length / ((ts.at(-1) - ts[0]) / 1000)) * 10) / 10, worst: Math.round(Math.max(0, ...d)) }); } })(t0);
})`;

async function measurePage(cdp, href) {
  const navMs = await navigate(cdp, href);
  const timedOut = navMs === -1;
  await cdp.sleep(1500); // let the page's own mount work settle
  const before = await taskSeconds(cdp);
  const p0 = await cdp.evaluate("({ raf: __probe.raf, actions: __probe.actions, lt: __probe.lt.length })");
  const wall0 = Date.now();
  await cdp.sleep(4000);
  const after = await taskSeconds(cdp);
  const p1 = await cdp.evaluate(`({ raf: __probe.raf, actions: __probe.actions, lt: __probe.lt.slice(${p0.lt}).reduce((s, l) => s + l.d, 0) })`);
  const wall = (Date.now() - wall0) / 1000;
  const scroll = await cdp.evaluate(SCROLL_FPS);
  return {
    page: href,
    navMs: timedOut ? ">120000" : navMs,
    idleBusyPct: Math.round(((after.task - before.task) / wall) * 1000) / 10,
    idleRafPerSec: Math.round((p1.raf - p0.raf) / wall),
    idleActionPosts: p1.actions - p0.actions,
    idleLongTaskMs: Math.round(p1.lt),
    scrollFps: scroll.fps,
    scrollWorstFrame: scroll.worst,
  };
}

async function visitGraph(cdp, { refresh }) {
  await navigate(cdp, "/graph").catch(() => {});
  await cdp.waitFor(`!!document.querySelector(".react-flow__node-contact") && document.querySelector(".constellation-stage")?.style.opacity === "1"`, 120_000);
  const stars = await cdp.evaluate(`document.querySelectorAll(".react-flow__node-contact").length`);
  // Twelve seconds of use: drag, wheel, hover — the same gestures the chart bench times.
  await cdp.evaluate(`new Promise((res) => {
    const pane = document.querySelector(".react-flow__pane"); const r = pane.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const m = (type, target, x, y) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: type === "mouseup" ? 0 : 1 }));
    const stars = [...document.querySelectorAll(".react-flow__node-contact")].slice(0, 30);
    const t0 = performance.now(); let i = 0, prev = null; m("mousedown", pane, cx, cy);
    (function f(t) {
      const el = t - t0;
      if (el < 4000) { const a = (el / 2000) * Math.PI * 2; m("mousemove", window, cx + Math.cos(a) * 200 - 200, cy + Math.sin(a) * 150); }
      else if (el < 4050) m("mouseup", window, cx, cy);
      else if (el < 8000) pane.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, deltaY: -12 * Math.sin((el / 2000) * Math.PI * 2) }));
      else if (el < 12000 && stars.length && Math.floor(el / 150) !== i) { i = Math.floor(el / 150); const n = stars[i % stars.length]; if (prev) prev.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: n })); n.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: prev ?? pane })); prev = n; }
      if (el < 12000) requestAnimationFrame(f); else { if (prev) prev.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: pane })); res(); }
    })(t0);
  })`);
  let refreshed = null;
  if (refresh) {
    await cdp.evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((el) => el.querySelector("svg.lucide-refresh-cw")); if (!b) throw new Error("no refresh button"); b.click(); })()`);
    await cdp.sleep(1500);
    refreshed = await cdp.evaluate("__probe.actions");
  }
  return { stars, actionsWhileOnGraph: refreshed };
}

async function runScenario(name) {
  const cdp = await launch({ width: 1440, height: 900, gpu: true });
  try {
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PRELUDE });
    await cdp.goto(`${base}/dashboard`);
    await cdp.waitHydrated();
    await cdp.waitFor(`(document.querySelector("main")?.innerText.length ?? 0) > 120`, 60_000);
    await cdp.sleep(2000);

    let graph = null;
    const t0 = Date.now();
    if (name !== "never") graph = await visitGraph(cdp, { refresh: name === "refresh" });
    // Keep the scenarios' clocks comparable: "never" idles for as long as a graph visit takes.
    else await cdp.sleep(20_000);
    const elapsedBeforeTour = Math.round((Date.now() - t0) / 1000);

    const pages = [];
    for (const href of TOUR) pages.push(await measurePage(cdp, href));
    await gc(cdp);
    const end = await taskSeconds(cdp);
    const probe = await cdp.evaluate("({ actions: __probe.actions, actionUrls: __probe.actionUrls })");
    return {
      scenario: name,
      graph,
      elapsedBeforeTour,
      pages,
      endHeapMB: Math.round((end.heap / 1048576) * 10) / 10,
      endDomNodes: end.nodes,
      endListeners: end.listeners,
      totalActionPosts: probe.actions,
      actionUrls: probe.actionUrls,
      errors: cdp.consoleErrors.slice(0, 5),
    };
  } finally {
    cdp.close();
  }
}

const results = [];
for (const s of scenarios) {
  process.stdout.write(`\n[${s}] … `);
  const r = await runScenario(s);
  results.push(r);
  console.log(`graph ${JSON.stringify(r.graph)} · heap after GC ${r.endHeapMB}MB · DOM ${r.endDomNodes} · listeners ${r.endListeners} · server-action POSTs ${r.totalActionPosts}`);
  for (const p of r.pages) {
    console.log(
      `   ${p.page.padEnd(11)} nav ${String(p.navMs).padStart(5)}ms  idle busy ${String(p.idleBusyPct).padStart(5)}%  rAF/s ${String(p.idleRafPerSec).padStart(4)}  ` +
        `action POSTs ${String(p.idleActionPosts).padStart(3)}  longtasks ${String(p.idleLongTaskMs).padStart(5)}ms  scroll ${p.scrollFps}fps (worst ${p.scrollWorstFrame}ms)`
    );
  }
}
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
process.exit(0);
