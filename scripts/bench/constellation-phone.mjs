/**
 * The phone constellation (the canvas renderer, graph-canvas-mobile.tsx) under load: pan and pinch
 * at several network sizes, on an emulated phone — 390x844 at DPR 3, touch, CPU throttled 4x (a
 * mid-range phone is roughly that far behind a laptop). The desktop bench (constellation-
 * interactions.mjs) never renders this path, because `useSmallSky` only picks it below 768px.
 *
 *   ORBIT_BENCH=1 npx next build --profile
 *   npx tsx scripts/bench/constellation-fixtures.ts 100,1000,2500,10000
 *   node scripts/bench/serve-static-bench.mjs 3417 --h2 &
 *   node scripts/bench/constellation-phone.mjs 100,1000,2500,10000 --reps 5 --label before --out phone.json
 *   node scripts/bench/constellation-phone.mjs 1000,10000 --reps 5 \
 *     --ab before=https://localhost:3418/bench/constellation,after=https://localhost:3417/bench/constellation
 *
 * Methodology (bump METHOD if you change it; old numbers stop being comparable):
 * - One fresh headless Chrome per repetition, GPU on, HTTP cache off, 40ms emulated RTT, as the
 *   desktop bench. A control frame rate from an empty page is taken BEFORE the CPU throttle; not
 *   ~60 means the machine is the ceiling (battery caps headless Chrome at 30fps) and the rep is
 *   dropped from the medians.
 * - Gestures are synthetic PointerEvents dispatched from inside the page, one step per animation
 *   frame, the events use-sky-gestures.ts listens for. CDP input would be the bottleneck itself.
 *     pan    one finger circles a 100px-radius loop for 3s.
 *     pinch  two fingers spread 80px -> 300px -> 80px over 3s about the centre (zoom in, then out).
 * - Per gesture: average FPS and minimum FPS (rAF deltas), p95 frame interval, frames over 33ms,
 *   main-thread cost per frame (rAF -> a message posted from it, after style/layout/paint), long
 *   tasks and long animation frames.
 * - "canvas" is when the chart's canvas first existed, ms since navigation: the phone path has no
 *   `constellation:*` marks, so this is the closest comparable "opens in".
 */
import { writeFileSync } from "node:fs";
import { launch } from "../dev/cdp.mjs";

export const METHOD = "constellation-phone/1";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const sizes = (argv.find((a) => /^\d[\d,]*$/.test(a)) ?? "100,1000,2500,10000").split(",").map(Number);
const reps = Number(flag("--reps") ?? 3);
const label = flag("--label") ?? "run";
const out = flag("--out");
const cpuRate = Number(flag("--cpu") ?? 4);
const base = flag("--base") ?? process.env.BENCH_URL ?? "https://localhost:3417/bench/constellation";
const targets = flag("--ab")
  ? flag("--ab").split(",").map((pair) => {
      const i = pair.indexOf("=");
      return { label: pair.slice(0, i), base: pair.slice(i + 1) };
    })
  : [{ label, base }];

const GESTURE_MS = 3000;
const SETTLE_MS = 3500;
const LATENCY_MS = 40;
const MIN_CONTROL_FPS = 55;

const PRELUDE = `
window.__lt = []; window.__loaf = [];
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ s: e.startTime, d: e.duration }); }).observe({ type: "longtask", buffered: true }); } catch {}
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__loaf.push({ s: e.startTime, d: e.duration }); }).observe({ type: "long-animation-frame", buffered: true }); } catch {}
window.__canvasAt = null;
new MutationObserver((_, obs) => {
  if (document.querySelector('[aria-label="Constellation star chart"] canvas')) { window.__canvasAt = performance.now(); obs.disconnect(); }
}).observe(document, { childList: true, subtree: true });
`;

/** Drags one finger 120px across the chart and reports whether the canvas pixels changed. */
const PROBE = `new Promise((resolve) => {
  const el = document.querySelector('[aria-label="Constellation star chart"]');
  const canvas = el.querySelector("canvas");
  const sig = () => { const s = canvas.toDataURL("image/png"); let h = s.length; for (let i = 0; i < s.length; i += 97) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const ev = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1 }));
  const before = sig();
  ev("pointerdown", cx, cy);
  let i = 0;
  (function step() {
    ev("pointermove", cx + (++i) * 10, cy);
    if (i < 12) return requestAnimationFrame(step);
    ev("pointerup", cx + 120, cy);
    setTimeout(() => resolve(sig() !== before), 300);
  })();
})`;

/** The in-page driver: runs one gesture for GESTURE_MS and resolves with its frame stats. */
const GESTURE = (kind) => `new Promise((resolve) => {
  const el = document.querySelector('[aria-label="Constellation star chart"]');
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const ev = (type, id, x, y) => el.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType: "touch", isPrimary: id === 1, bubbles: true, cancelable: true,
    clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1,
  }));
  const kind = ${JSON.stringify(kind)};
  const ms = ${GESTURE_MS};
  const t0 = performance.now();
  const ts = [], cost = [];
  const ch = new MessageChannel();
  let startOfFrame = 0;
  ch.port1.onmessage = () => cost.push(performance.now() - startOfFrame);
  if (kind === "pan") ev("pointerdown", 1, cx + 100, cy);
  else { ev("pointerdown", 1, cx - 40, cy); ev("pointerdown", 2, cx + 40, cy); }
  function frame(now) {
    startOfFrame = performance.now();
    ts.push(now);
    const p = Math.min(1, (now - t0) / ms);
    if (kind === "pan") {
      const a = p * Math.PI * 2;
      ev("pointermove", 1, cx + Math.cos(a) * 100, cy + Math.sin(a) * 100);
    } else {
      const half = 40 + 110 * (1 - Math.abs(1 - p * 2));
      ev("pointermove", 1, cx - half, cy);
      ev("pointermove", 2, cx + half, cy);
    }
    ch.port2.postMessage(0);
    if (p < 1) return requestAnimationFrame(frame);
    if (kind === "pan") ev("pointerup", 1, cx + 100, cy); else { ev("pointerup", 1, cx - 40, cy); ev("pointerup", 2, cx + 40, cy); }
    setTimeout(() => {
      const d = ts.slice(1).map((t, i) => t - ts[i]);
      const sorted = [...d].sort((a, b) => a - b);
      const csorted = [...cost].sort((a, b) => a - b);
      const winLt = window.__lt.filter((l) => l.s >= t0 && l.s < t0 + ms).length;
      const winLoaf = window.__loaf.filter((l) => l.s >= t0 && l.s < t0 + ms).length;
      resolve({
        frames: ts.length,
        avgFps: +(((ts.length - 1) / ((ts.at(-1) - ts[0]) / 1000))).toFixed(1),
        minFps: +(1000 / Math.max(...d)).toFixed(1),
        p95Interval: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
        over33: d.filter((x) => x > 33.4).length,
        costP50: +csorted[Math.floor(csorted.length * 0.5)].toFixed(1),
        costP95: +csorted[Math.floor(csorted.length * 0.95)].toFixed(1),
        costMax: +csorted.at(-1).toFixed(1),
        longTasks: winLt, loaf: winLoaf,
      });
    }, 50);
  }
  requestAnimationFrame(frame);
})`;

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

/** `cdp.evaluate` has no timeout of its own; a wedged page would hang the whole run. */
async function evaluateWithin(cdp, expr, ms = 120_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`evaluate timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([cdp.evaluate(expr), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOnce(n, { base }) {
  const cdp = await launch({ width: 390, height: 844, mobile: true, gpu: true, extraArgs: ["--ignore-certificate-errors"] });
  try {
    await cdp.goto("data:text/html,<body></body>");
    const controlFps = await evaluateWithin(cdp, `new Promise((res) => { const ts = []; const t0 = performance.now(); (function f(t) { ts.push(t); if (t - t0 < 2000) requestAnimationFrame(f); else res(Math.round(((ts.length - 1) / ((ts.at(-1) - ts[0]) / 1000)) * 10) / 10); })(t0); })`, 30_000);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY_MS, downloadThroughput: -1, uploadThroughput: -1 });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PRELUDE });

    await cdp.goto(`${base}?n=${n}&data=fetch`);
    await cdp.waitFor(`window.__canvasAt !== null`, 180_000);
    const canvas = await cdp.evaluate(`Math.round(window.__canvasAt)`);
    const longTasksToCanvas = await cdp.evaluate(`window.__lt.filter((l) => l.s <= window.__canvasAt).length`);
    await sleep(SETTLE_MS);
    // Untimed: a 120px drag must change what the canvas shows, or the gestures below measure nothing.
    const moved = await evaluateWithin(cdp, PROBE, 30_000);
    if (!moved) throw new Error("probe drag did not change the canvas; the synthetic gestures are not reaching the camera");
    await sleep(1000);
    const res = { controlFps, canvas, longTasksToCanvas };
    for (const kind of ["pan", "pinch"]) {
      res[kind] = await evaluateWithin(cdp, GESTURE(kind), GESTURE_MS + 30_000);
      await sleep(1500);
    }
    return res;
  } finally {
    cdp.close();
  }
}

const results = [];
for (const n of sizes) {
  for (let rep = 0; rep < reps; rep++) {
    // Alternate which build goes first so drifting machine load lands on both sides.
    const order = rep % 2 ? [...targets].reverse() : targets;
    for (const t of order) {
      try {
        const r = await runOnce(n, t);
        results.push({ label: t.label, n, rep, ...r });
        console.log(`${t.label} n=${n} rep=${rep} control=${r.controlFps} canvas=${r.canvas}ms pan=${r.pan.avgFps}/${r.pan.minFps}fps pinch=${r.pinch.avgFps}/${r.pinch.minFps}fps`);
      } catch (e) {
        console.log(`${t.label} n=${n} rep=${rep} FAILED ${e.message}`);
      }
    }
  }
}

const rows = [];
for (const t of targets) {
  for (const n of sizes) {
    const all = results.filter((r) => r.label === t.label && r.n === n);
    const kept = all.filter((r) => r.controlFps >= MIN_CONTROL_FPS);
    const m = (f) => median(kept.map(f));
    rows.push({
      label: t.label, n, kept: kept.length, dropped: all.length - kept.length,
      canvasMs: m((r) => r.canvas), longTasksToCanvas: m((r) => r.longTasksToCanvas),
      panAvg: m((r) => r.pan.avgFps), panMin: m((r) => r.pan.minFps), panP95: m((r) => r.pan.p95Interval), panOver33: m((r) => r.pan.over33), panCostP95: m((r) => r.pan.costP95), panLoaf: m((r) => r.pan.loaf),
      pinchAvg: m((r) => r.pinch.avgFps), pinchMin: m((r) => r.pinch.minFps), pinchP95: m((r) => r.pinch.p95Interval), pinchOver33: m((r) => r.pinch.over33), pinchCostP95: m((r) => r.pinch.costP95), pinchLoaf: m((r) => r.pinch.loaf),
    });
  }
}
console.table(rows);
if (out) writeFileSync(out, JSON.stringify({ method: METHOD, cpuRate, results, rows }, null, 2));
