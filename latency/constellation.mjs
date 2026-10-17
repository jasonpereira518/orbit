/**
 * Constellation (/graph) open time and frame rate at each network size, in headless Chromium
 * via Playwright, on both device profiles.
 *
 *   ORBIT_BENCH=1 npx next build                               # adds /bench/constellation
 *   npx tsx scripts/bench/constellation-fixtures.ts 500,5000,50000
 *   node scripts/bench/serve-static-bench.mjs 3417 &
 *   node latency/constellation.mjs --sizes=500,5000,50000 [--base=http://localhost:3417] [--profile=both] [--out=...]
 *
 * This is a Playwright port of the measurement in scripts/bench/constellation-browser.mjs
 * (which drives Chrome through a hard-coded macOS path): the same static bench page, the
 * same synthetic payload fetched over the network (`?data=fetch`), the same in-page rAF
 * loop for frame times. Reported per size and profile:
 *   fetch_kb      payload size on the wire
 *   ready_ms      navigation start → first frame the chart is revealed with nodes mounted
 *   idle_fps      frames per second over 2 s with nothing happening
 *   pan_fps       frames per second over 3 s of synthetic drag events
 *   zoom_fps      frames per second over 2 s of wheel zoom
 *   long_tasks_ms total long-task time until ready
 *   heap_mb       JS heap after the run
 * The 50,000 tier opens in the chart's summary view by design (clusters plus a dot canvas).
 */
import { chromium } from "playwright";
import { chromiumExecutable, flag, PROFILES, r0, r1, sleep, writeJson } from "./lib/stats.mjs";

const BASE = flag("base", "http://localhost:3417").replace(/\/$/, "");
const SIZES = (flag("sizes", "500,5000,50000")).split(",").map(Number);
const PROFILE = flag("profile", "both");
const OUT = flag("out", `latency/results/constellation-${Date.now()}.json`);

const PRELUDE = `
window.__lt = []; window.__ready = null;
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: "longtask", buffered: true }); } catch {}
(function poll() {
  const el = document.querySelector(".constellation-stage");
  if (el && el.style.opacity === "1" && document.querySelector(".react-flow__node")) { window.__ready = performance.now(); return; }
  requestAnimationFrame(poll);
})();`;

const KIT = `(() => {
  // Desktop renders React Flow (a pane element); the phone layout renders its own canvas
  // (graph-canvas-mobile.tsx), so fall back to the stage's canvas, then the stage itself.
  const pane = () => document.querySelector(".react-flow__pane") ?? document.querySelector(".constellation-stage canvas") ?? document.querySelector(".constellation-stage") ?? document.body;
  const center = () => { const r = pane().getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const mouse = (type, target, x, y, extra = {}) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: type === "mouseup" ? 0 : 1, ...extra }));
  const wheel = (x, y, dy) => pane().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: dy, deltaMode: 0, ctrlKey: false }));
  window.__phase = (name, ms) => new Promise((resolve) => {
    const frames = []; let last = performance.now(); const start = last; let i = 0; const c = center();
    if (name === "pan") mouse("mousedown", pane(), c.x, c.y);
    const tick = (now) => {
      frames.push(now - last); last = now; i++;
      if (name === "pan") mouse("mousemove", pane(), c.x + Math.sin(i / 20) * 200, c.y + Math.cos(i / 20) * 120);
      if (name === "zoom") wheel(c.x, c.y, i % 40 < 20 ? -40 : 40);
      if (now - start < ms) return requestAnimationFrame(tick);
      if (name === "pan") mouse("mouseup", pane(), c.x, c.y);
      const s = [...frames].sort((a, b) => a - b);
      resolve({ fps: Math.round((frames.length / (now - start)) * 1000 * 10) / 10, p95_frame_ms: Math.round(s[Math.floor(s.length * 0.95)] * 10) / 10 });
    };
    requestAnimationFrame(tick);
  });
})();`;

async function measure(browser, profile, n) {
  const p = PROFILES[profile];
  const context = await browser.newContext({ viewport: p.viewport, isMobile: p.mobile, hasTouch: p.mobile, deviceScaleFactor: p.deviceScaleFactor ?? 1, ignoreHTTPSErrors: true });
  await context.addInitScript(PRELUDE);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (p.network) { await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", { offline: false, ...p.network }); }
  if (p.cpuRate > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: p.cpuRate });
  try {
    await page.goto(`${BASE}/bench/constellation?n=${n}&seed=1&data=fetch`, { waitUntil: "commit" });
    const t0 = Date.now();
    let ready = null;
    while (Date.now() - t0 < 120_000) { ready = await page.evaluate(() => window.__ready).catch(() => null); if (ready != null) break; await sleep(100); }
    const fetchKb = await page.evaluate(() => Math.round(performance.getEntriesByType("resource").filter((r) => r.name.includes("/bench-data/")).reduce((a, r) => a + r.transferSize, 0) / 1024));
    const longTasks = await page.evaluate(() => Math.round(window.__lt.reduce((a, b) => a + b, 0)));
    await page.evaluate(KIT);
    await sleep(500);
    const idle = await page.evaluate(() => window.__phase("idle", 2000));
    const pan = await page.evaluate(() => window.__phase("pan", 3000));
    const zoom = await page.evaluate(() => window.__phase("zoom", 2000));
    const nodes = await page.evaluate(() => document.querySelectorAll(".react-flow__node").length);
    const heap = await cdp.send("Runtime.getHeapUsage").catch(() => null);
    return { n, profile, fetch_kb: fetchKb, ready_ms: r0(ready), long_tasks_ms: longTasks, idle_fps: idle.fps, pan_fps: pan.fps, pan_p95_frame_ms: pan.p95_frame_ms, zoom_fps: zoom.fps, nodes, heap_mb: heap ? r1(heap.usedSize / 1048576) : null, timeout: ready == null };
  } catch (err) {
    return { n, profile, error: String(err).slice(0, 200) };
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable(chromium), args: ["--ignore-certificate-errors", "--enable-gpu-rasterization"] });
try {
  const rows = [];
  for (const profile of PROFILE === "both" ? ["desktop", "mobile4g"] : [PROFILE]) {
    for (const n of SIZES) {
      const row = await measure(browser, profile, n);
      console.log(JSON.stringify(row));
      rows.push(row);
    }
  }
  writeJson(OUT, { base: BASE, at: new Date().toISOString(), rows });
} finally {
  await browser.close();
}
