/**
 * The constellation's three core interactions — opening it, zooming, panning — measured the same
 * way every time, at several network sizes, so a before and an after are comparable.
 *
 *   ORBIT_BENCH=1 npx next build --profile
 *   npx tsx scripts/bench/constellation-fixtures.ts 100,1000,2500,5000,10000
 *   node scripts/bench/serve-static-bench.mjs 3417 --h2 &
 *   node scripts/bench/constellation-interactions.mjs 100,1000,2500,5000,10000 --reps 3 --label before --out before.json
 *
 * or, to compare two builds (the other served with BENCH_NEXT_DIR on another port):
 *
 *   node scripts/bench/constellation-interactions.mjs 100,1000,2500,5000,10000 --reps 5 \
 *     --ab before=https://localhost:3418/bench/constellation,after=https://localhost:3417/bench/constellation --out ab.json
 *   node scripts/bench/constellation-report.mjs ab.json      # the markdown table
 *
 * Methodology (fixed; change it and old results stop being comparable — bump METHOD if you do):
 *
 * - One fresh headless Chrome per repetition, GPU raster on, 1440x900 at DPR 1, HTTP cache off,
 *   and 40ms of emulated round-trip latency on every request (localhost has none, and without it
 *   a request waterfall costs nothing and cannot be seen). Throughput is not throttled.
 * - Served over HTTP/2 (`serve-static-bench.mjs --h2`), as production is. Over HTTP/1.1 the six-
 *   connection cap turns a dozen chunk requests into three RTT-spaced waves.
 * - A control frame rate from an empty page first. Not ~60 means the machine is the ceiling.
 *
 * OPEN — `/bench/constellation?n=N&data=fetch`: the payload is fetched and parsed, as the real
 *   page's is. Stages come from the `constellation:*` performance marks the app itself sets
 *   (src/lib/graph/open-marks.ts): data-fetch-start → data-received → renderer-loaded →
 *   layout-computed → first-paint → interactive. Time-to-interactive is the `interactive` mark's
 *   time since navigation start. Long tasks are counted from navigation to `interactive`.
 *
 * Then 3.5s to settle (intro handover, entrance animations), then each gesture below. Every
 * gesture drives itself from inside the page, one synthetic event per animation frame, because
 * CDP input costs ~110ms an event and would be the bottleneck being measured. Each is set up
 * untimed, given 1.5s to settle, and then recorded for exactly GESTURE_MS:
 *
 * ZOOM IN  — from the minimum zoom (0.05) to the maximum (2.4), about the pane centre (the sun,
 *   which the opening frame centres), following zoom(t) = min·(max/min)^(t/3s): each frame's wheel
 *   delta is whatever takes the current zoom to that curve, so a dropped frame means a bigger
 *   step, not a slower zoom.
 * ZOOM OUT — the same curve, backwards.
 * PAN (overview) — at the opening framing, the pointer drags once around a 240px-radius circle.
 * PAN (close-up) — at zoom 0.5 centred on the sun, the pointer drags 1,800px straight left: the
 *   camera crosses 3,600 world px of sky, so stars enter and leave the view all the way.
 *
 * Per gesture: average FPS (rAF frames ÷ seconds), minimum FPS (1000 ÷ the longest frame), and
 * the count of long tasks (> 50ms, PerformanceObserver `longtask`) that started in the window.
 * Each size runs `--reps` times; the report uses the median of each metric.
 *
 * FRAME SUITE (`--suite frame`, method /2) — the interactions that drop
 * frames on a 120Hz display, each set up untimed and recorded like the gestures above:
 *   summary-cross    zoom 0.09 → 0.25 → 0.09 over 3s: out of the summary view, across the 0.2
 *                    cluster-name threshold, and back.
 *   pinch-trackpad   ctrl-wheel (a trackpad pinch) with small deltas, two events a frame, zooming
 *                    0.05 → 1 → 0.05 over 3s.
 *   wheel-notch      mouse-wheel notches (±100) at 0.3: every 180ms for 1.5s, then every 90ms.
 *   hover-sweep      at zoom 0.5, the pointer moves to a new star every frame for 2s.
 *   hover-drift      at the opening view, the pointer drifts across the whole sky for 3s, one
 *                    mousemove a frame, over clusters and the gaps between them.
 *   search-type      "stri" typed 120ms a key from the home view, then 2s for the camera flight
 *                    and the late semantic update; the search is cleared afterwards.
 *   cluster-click    a click on the cluster name nearest the centre from home; 1.5s of flight,
 *                    summary exit and star mounting.
 * Extra per-gesture metrics: each frame's main-thread cost (rAF → after paint): how many exceed
 * 8.33ms (a dropped frame at 120Hz) and 16.7ms, p50/p95/max; long
 * animation frames (LoAF, > 50ms, with the scripts that ran in them), and React commits (count,
 * total ms, most in one frame; per hover for hover-sweep).
 *
 * `--trace-dir d` adds one more, unscored repetition that records each gesture as a Chrome trace
 * (`d/<label>-<n>-<gesture>.json`; DevTools → Performance → Load profile). Unscored because
 * tracing costs frames of its own.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "../dev/cdp.mjs";

/**
 * /3: the driver reads the zoom from the viewport's inline transform instead of
 * `getComputedStyle`, which forced a style recalculation of the whole chart inside every pinch
 * frame (~200ms per 3s pinch at 2,500 stars) — a cost a real trackpad never adds. Numbers from
 * /2 and /3 are not comparable; compare builds within one method.
 */
export const METHOD = "constellation-interactions/3";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const sizes = (argv.find((a) => /^\d[\d,]*$/.test(a)) ?? "100,1000,2500,5000,10000")
  .split(",")
  .map(Number);
const reps = Number(flag("--reps") ?? 3);
const label = flag("--label") ?? "run";
const out = flag("--out");
const traceDir = flag("--trace-dir");
/**
 * `--suite frame`: the frame-budget suite (see FRAME SUITE below) instead of the open/zoom/pan one.
 * `--uncapped`: lift headless Chrome's 60Hz vsync cap. Diagnostic only: rAF then spins far faster
 * than any display and in-page drivers send unrealistic event rates. The frame suite measures the
 * 120Hz budget without it — see `work` in `record`.
 */
const suite = flag("--suite") ?? "open";
const uncapped = argv.includes("--uncapped");
/** `--gestures a,b`: run only these gestures of the suite (for iterating on one fix). */
const onlyGestures = flag("--gestures")?.split(",") ?? null;
const base = flag("--base") ?? process.env.BENCH_URL ?? "https://localhost:3417/bench/constellation";
/**
 * `--ab before=URL,after=URL`: measure two builds interleaved — every repetition runs both, in
 * alternating order — so machine load drifting over a long run lands on both sides equally.
 */
const targets = flag("--ab")
  ? flag("--ab").split(",").map((pair) => {
      const i = pair.indexOf("=");
      return { label: pair.slice(0, i), base: pair.slice(i + 1) };
    })
  : [{ label, base }];

const GESTURE_MS = 3000;
const SETTLE_MS = 1500;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 2.4;
const CLOSEUP_ZOOM = 0.5;
const LATENCY_MS = 40;

/** Before any page script: collect long tasks from the very start of the navigation. */
const PRELUDE = `
window.__lt = [];
try {
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ s: e.startTime, d: e.duration }); })
    .observe({ type: "longtask", buffered: true });
} catch {}
window.__loaf = [];
try {
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      window.__loaf.push({
        s: e.startTime,
        d: e.duration,
        block: e.blockingDuration,
        styleLayout: e.renderStart && e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
        scripts: (e.scripts || []).map((x) => ({ fn: x.sourceFunctionName || x.invoker || "?", url: (x.sourceURL || "").split("/").pop(), d: x.duration, forced: x.forcedStyleAndLayoutDuration })),
      });
    }
  }).observe({ type: "long-animation-frame", buffered: true });
} catch {}
`;

/** The in-page gesture kit. */
const KIT = `
window.__ix = (() => {
  const pane = () => document.querySelector(".react-flow__pane");
  const centre = () => { const r = pane().getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  // React Flow writes the camera as the viewport's inline \`translate(…) scale(k)\`; reading that
  // string forces no style recalculation, where getComputedStyle recalculated the whole chart.
  const zoomNow = () => { const v = document.querySelector(".react-flow__viewport"); const m = v && /scale\\(([^)]+)\\)/.exec(v.style.transform); if (m) return Number(m[1]); const c = v && getComputedStyle(v).transform.match(/matrix\\(([^,]+)/); return c ? Number(c[1]) : 1; };
  const wheel = (deltaY) => { const c = centre(); pane().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, view: window, clientX: c.x, clientY: c.y, deltaY, deltaMode: 0 })); };
  // React Flow: scale *= 2^(-deltaY * 0.002) for a pixel-mode wheel event (no ctrl).
  const wheelTo = (k) => { const cur = zoomNow(); if (Math.abs(Math.log2(k / cur)) > 1e-4) wheel(-Math.log2(k / cur) / 0.002); };
  const mouse = (type, target, x, y) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: type === "mouseup" ? 0 : 1 }));

  /** Record every frame for \`ms\`, calling driver.step(elapsed) inside each frame. */
  async function record(ms, driver) {
    const lt0 = window.__lt.length;
    const ts = [];
    // Main-thread cost of each frame: from its rAF callback (where the driver's input lands) to a
    // message posted from that callback, which runs after the frame's style, layout and paint.
    // A frame whose cost is over 8.33ms would drop on a 120Hz display even though headless Chrome
    // paces at 60Hz — the pacing keeps input rates realistic, the cost is what the budget needs.
    const work = [];
    const channel = new MessageChannel();
    let frameStart = 0;
    channel.port1.onmessage = () => work.push(performance.now() - frameStart);
    driver.start?.();
    const t0 = performance.now();
    await new Promise((res) => {
      function f(t) {
        ts.push(t);
        frameStart = performance.now();
        const el = t - t0;
        if (el < ms) { driver.step(Math.min(el, ms)); channel.port2.postMessage(null); requestAnimationFrame(f); } else { driver.step(ms); channel.port2.postMessage(null); res(); }
      }
      requestAnimationFrame(f);
    });
    driver.end?.();
    // A long task still running when the window closes reports when it ends.
    await new Promise((r) => setTimeout(r, 120));
    const loafs = (window.__loaf || []).filter((l) => l.s >= t0 && l.s < t0 + ms);
    const commits = (window.__bench?.commits || []).filter((c) => c.at >= t0 && c.at < t0 + ms);
    // Commits per frame: bucket each commit into the frame interval it landed in.
    let maxPerFrame = 0;
    for (let i = 1; i < ts.length; i++) {
      const k = commits.filter((c) => c.at >= ts[i - 1] && c.at < ts[i]).length;
      if (k > maxPerFrame) maxPerFrame = k;
    }
    const scriptTotals = {};
    for (const l of loafs) for (const x of l.scripts) scriptTotals[x.fn] = (scriptTotals[x.fn] || 0) + x.d;
    const d = ts.slice(1).map((t, i) => t - ts[i]);
    const span = (ts.at(-1) - ts[0]) / 1000;
    const lts = window.__lt.slice(lt0).filter((l) => l.s >= t0 && l.s < t0 + ms);
    const sorted = [...d].sort((a, b) => a - b);
    const pct = (xs, p) => { if (!xs.length) return 0; const v = [...xs].sort((a, b) => a - b); return v[Math.floor(p * (v.length - 1))]; };
    const longest = Math.max(0, ...d);
    return {
      avgFps: Math.round((d.length / span) * 10) / 10,
      minFps: Math.round((1000 / Math.max(longest, 1000 / 60)) * 10) / 10,
      longTasks: lts.length,
      longTaskMs: Math.round(lts.reduce((s, l) => s + l.d, 0)),
      longestFrameMs: Math.round(longest * 10) / 10,
      p95FrameMs: Math.round(sorted[Math.floor(0.95 * (sorted.length - 1))] * 10) / 10,
      frames: d.length,
      endZoom: Math.round(zoomNow() * 1000) / 1000,
      stars: document.querySelectorAll(".react-flow__node-contact").length,
      over8: work.filter((x) => x > 1000 / 120).length,
      over16: work.filter((x) => x > 1000 / 60).length,
      over8Pct: Math.round((1000 * work.filter((x) => x > 1000 / 120).length) / Math.max(1, work.length)) / 10,
      workP50Ms: Math.round(pct(work, 0.5) * 10) / 10,
      workP95Ms: Math.round(pct(work, 0.95) * 10) / 10,
      workMaxMs: Math.round(Math.max(0, ...work) * 10) / 10,
      workTotalMs: Math.round(work.reduce((a, x) => a + x, 0)),
      loafs: loafs.length,
      loafMs: Math.round(loafs.reduce((a, l) => a + l.d, 0)),
      loafTopScripts: Object.entries(scriptTotals).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => k + ":" + Math.round(v)).join(" "),
      commits: commits.length,
      commitMs: Math.round(commits.reduce((a, c) => a + c.actual, 0)),
      maxCommitsPerFrame: maxPerFrame,
      events: driver.events ?? null,
      commitsPerEvent: driver.events ? Math.round((commits.length / driver.events) * 100) / 100 : null,
    };
  }

  const zoomCurve = (from, to, ms) => ({ step(el) { wheelTo(from * Math.pow(to / from, el / ms)); } });

  function panCircle(radius, ms) {
    let c;
    return {
      start() { c = centre(); mouse("mousedown", pane(), c.x, c.y); },
      step(el) { const a = (el / ms) * Math.PI * 2; mouse("mousemove", window, c.x + Math.cos(a) * radius - radius, c.y + Math.sin(a) * radius); },
      end() { mouse("mouseup", window, c.x, c.y); },
    };
  }

  function panLine(dx, ms) {
    let c;
    return {
      start() { c = centre(); mouse("mousedown", pane(), c.x, c.y); },
      step(el) { mouse("mousemove", window, c.x + (dx * el) / ms, c.y); },
      end() { mouse("mouseup", window, c.x + dx, c.y); },
    };
  }

  const ctrlWheel = (deltaY) => { const c = centre(); pane().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, view: window, clientX: c.x, clientY: c.y, deltaY, deltaMode: 0, ctrlKey: true })); };
  /** How much one unit of ctrl-wheel delta zooms here (React Flow scales pinches ×10 on macOS). */
  function pinchFactor() {
    const k0 = zoomNow();
    ctrlWheel(-10);
    const k1 = zoomNow();
    wheelTo(k0);
    return Math.log2(k1 / k0) / 10;
  }

  /** zoom(t) from→mid→from, as trackpad pinch events: \`perFrame\` small ctrl-wheel events a frame. */
  function pinch(from, mid, ms, perFrame) {
    let per;
    const d = { events: 0 };
    d.start = () => { per = pinchFactor(); };
    d.step = (el) => {
      const half = ms / 2;
      const t = el < half ? el / half : 1 - (el - half) / half;
      const target = from * Math.pow(mid / from, Math.max(0, Math.min(1, t)));
      const total = Math.log2(target / zoomNow()) / per;
      if (Math.abs(total) < 1e-3) return;
      for (let i = 0; i < perFrame; i++) { ctrlWheel(-total / perFrame); d.events++; }
    };
    return d;
  }

  /** Mouse-wheel notches: in ×4, out ×4, …, every \`slow\`ms for half the window, then every \`fast\`ms. */
  function notches(ms, slow, fast) {
    let last = -1e9, i = 0;
    const d = { events: 0 };
    d.step = (el) => {
      const gap = el < ms / 2 ? slow : fast;
      if (el - last < gap) return;
      last = el;
      wheel(Math.floor(i++ / 4) % 2 ? 100 : -100);
      d.events++;
    };
    return d;
  }

  /** Stars in the view, nearest the centre first. */
  function starsInView(limit) {
    const vw = innerWidth, vh = innerHeight;
    return [...document.querySelectorAll(".react-flow__node-contact")]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.left > 0 && r.top > 0 && r.right < vw && r.bottom < vh)
      .sort((a, b) => Math.hypot(a.r.left - vw / 2, a.r.top - vh / 2) - Math.hypot(b.r.left - vw / 2, b.r.top - vh / 2))
      .slice(0, limit)
      .map(({ el }) => el);
  }

  /** A new star under the pointer every frame. */
  function hoverSweep() {
    let stars = [], i = 0, prev = null;
    const d = { events: 0 };
    d.start = () => { stars = starsInView(200); };
    d.step = () => {
      if (!stars.length) return;
      const next = stars[i++ % stars.length];
      const r = next.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (prev) prev.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, view: window, relatedTarget: next, clientX: x, clientY: y }));
      next.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, view: window, relatedTarget: prev ?? pane(), clientX: x, clientY: y }));
      prev = next;
      d.events++;
    };
    d.end = () => { if (prev) prev.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, view: window, relatedTarget: pane() })); };
    return d;
  }

  /** Type \`text\` into the chart's search, one key every \`gap\`ms, then keep recording. */
  function type(text, gap) {
    let input, last = -1e9, k = 1;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    const d = { events: 0 };
    d.start = () => { input = document.querySelector('input[placeholder^="Search name"]'); input?.focus(); };
    d.step = (el) => {
      if (!input || k > text.length || el - last < gap) return;
      last = el;
      setter.call(input, text.slice(0, k++));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      d.events++;
    };
    return d;
  }

  /** Click the cluster name nearest the centre, once. */
  function clusterClick() {
    let done = false;
    const d = { events: 0 };
    d.step = () => {
      if (done) return;
      done = true;
      const vw = innerWidth, vh = innerHeight;
      const el = [...document.querySelectorAll(".react-flow__node-clusterLabel")]
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.left > 0 && r.top > 0 && r.right < vw && r.bottom < vh)
        .sort((a, b) => Math.hypot(a.r.left + a.r.width / 2 - vw / 2, a.r.top - vh / 2) - Math.hypot(b.r.left + b.r.width / 2 - vw / 2, b.r.top - vh / 2))[0]?.e;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
      el.dispatchEvent(new MouseEvent("mousedown", { ...o, buttons: 1 }));
      el.dispatchEvent(new MouseEvent("mouseup", o));
      el.dispatchEvent(new MouseEvent("click", o));
      d.events++;
    };
    return d;
  }

  /** zoom from→to→from over ms (pixel wheel, one event a frame). */
  const zoomThere = (from, to, ms) => ({ step(el) { const h = ms / 2; const t = el < h ? el / h : 1 - (el - h) / h; wheelTo(from * Math.pow(to / from, Math.max(0, Math.min(1, t)))); } });

  function clearSearch() {
    const input = document.querySelector('input[placeholder^="Search name"]');
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.blur();
  }

  /** The pointer drifting across the sky: a slow lemniscate over the pane, one move a frame. */
  function drift(ms) {
    let r;
    const d = { events: 0 };
    d.start = () => { r = pane().getBoundingClientRect(); };
    d.step = (el) => {
      const a = (el / ms) * Math.PI * 2;
      const x = r.left + r.width * (0.5 + 0.42 * Math.sin(a));
      const y = r.top + r.height * (0.5 + 0.38 * Math.sin(a) * Math.cos(a));
      const target = document.elementFromPoint(x, y) ?? pane();
      target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
      target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
      d.events++;
    };
    return d;
  }

  function goHome() { document.querySelector('button[aria-label="Reset map to home"]')?.click(); }

  return { zoomNow, wheelTo, record, zoomCurve, panCircle, panLine, pinch, notches, hoverSweep, type, clusterClick, zoomThere, clearSearch, goHome, drift };
})();
`;

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

/** Run `expr` under a DevTools-format trace and write it to `file`. */
async function traced(cdp, expr, file) {
  const events = [];
  cdp.onEvent("Tracing.dataCollected", (p) => events.push(...p.value));
  const done = new Promise((r) => cdp.onEvent("Tracing.tracingComplete", r));
  await cdp.send("Tracing.start", {
    traceConfig: {
      includedCategories: [
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.frame",
        "blink.user_timing",
        "v8.execute",
        "loading",
      ],
      recordMode: "recordAsMuchAsPossible",
    },
    transferMode: "ReportEvents",
  });
  const result = await evaluateWithin(cdp, expr);
  await cdp.send("Tracing.end");
  await done;
  writeFileSync(file, JSON.stringify({ traceEvents: events }));
  return result;
}

async function runOnce(n, traced_, { label, base }) {
  // The bench server's certificate is self-signed.
  const cdp = await launch({
    width: 1440,
    height: 900,
    gpu: true,
    extraArgs: [
      "--ignore-certificate-errors",
      ...(uncapped ? ["--disable-gpu-vsync", "--disable-frame-rate-limit"] : []),
    ],
  });
  try {
    await cdp.goto("data:text/html,<body></body>");
    const controlFps = await evaluateWithin(cdp, `new Promise((res) => { const ts = []; const t0 = performance.now(); (function f(t) { ts.push(t); if (t - t0 < 2000) requestAnimationFrame(f); else res(Math.round(((ts.length - 1) / ((ts.at(-1) - ts[0]) / 1000)) * 10) / 10); })(t0); })`, 30_000);

    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: LATENCY_MS,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PRELUDE });

    // ---- OPEN ----
    await cdp.goto(`${base}?n=${n}&data=fetch`);
    await cdp.waitFor(`performance.getEntriesByName("constellation:interactive").length > 0`, 180_000);
    const open = await cdp.evaluate(`(() => {
      const at = (s) => performance.getEntriesByName("constellation:" + s).at(-1)?.startTime ?? null;
      const m = {};
      for (const s of ["data-fetch-start", "data-received", "renderer-loaded", "layout-computed", "first-paint", "interactive"]) m[s] = at(s);
      const r = (x) => (x === null ? null : Math.round(x));
      const lts = window.__lt.filter((l) => l.s <= m.interactive);
      return {
        tti: r(m.interactive),
        stages: {
          boot: r(m["data-fetch-start"]),
          data: r(m["data-received"] - m["data-fetch-start"]),
          renderer: r(m["renderer-loaded"] - m["data-received"]),
          layout: r(m["layout-computed"] - m["renderer-loaded"]),
          paint: r(m["first-paint"] - m["layout-computed"]),
          settle: r(m.interactive - m["first-paint"]),
        },
        longTasks: lts.length,
        longTaskMs: Math.round(lts.reduce((s, l) => s + l.d, 0)),
        longestTaskMs: Math.round(Math.max(0, ...lts.map((l) => l.d))),
      };
    })()`);
    // Let the intro hand over and the entrance animations finish before any gesture.
    await cdp.sleep(3500);
    await cdp.evaluate(KIT);
    const homeZoom = await cdp.evaluate("__ix.zoomNow()");
    open.homeZoom = Math.round(homeZoom * 1000) / 1000;

    const gestures = {};
    const measure = async (name, setup, expr) => {
      if (onlyGestures && !onlyGestures.includes(name)) return;
      await evaluateWithin(cdp, setup);
      await cdp.sleep(SETTLE_MS);
      const file = traced_ ? join(traceDir, `${label}-${n}-${name}.json`) : null;
      gestures[name] = file ? await traced(cdp, expr, file) : await evaluateWithin(cdp, expr);
    };

    if (suite === "frame") {
      await measure("summary-cross", `__ix.wheelTo(0.09)`, `__ix.record(${GESTURE_MS}, __ix.zoomThere(0.09, 0.25, ${GESTURE_MS}))`);
      await measure("pinch-trackpad", `__ix.wheelTo(${MIN_ZOOM})`, `__ix.record(${GESTURE_MS}, __ix.pinch(${MIN_ZOOM}, 1, ${GESTURE_MS}, 2))`);
      await measure("wheel-notch", `__ix.wheelTo(0.3)`, `__ix.record(${GESTURE_MS}, __ix.notches(${GESTURE_MS}, 180, 90))`);
      await measure("hover-sweep", `__ix.wheelTo(${CLOSEUP_ZOOM})`, `__ix.record(2000, __ix.hoverSweep())`);
      await measure("hover-drift", `__ix.wheelTo(${homeZoom})`, `__ix.record(${GESTURE_MS}, __ix.drift(${GESTURE_MS}))`);
      await measure("search-type", `__ix.wheelTo(${homeZoom})`, `__ix.record(2500, __ix.type("stri", 120))`);
      // Back to the unsearched sky, and home, before the click.
      await evaluateWithin(cdp, `__ix.clearSearch()`);
      await cdp.sleep(1200);
      await evaluateWithin(cdp, `__ix.goHome()`);
      await cdp.sleep(1500);
      await measure("cluster-click", `void 0`, `__ix.record(1500, __ix.clusterClick())`);
    } else {
      await measure("zoom-in", `__ix.wheelTo(${MIN_ZOOM})`, `__ix.record(${GESTURE_MS}, __ix.zoomCurve(${MIN_ZOOM}, ${MAX_ZOOM}, ${GESTURE_MS}))`);
      await measure("zoom-out", `__ix.wheelTo(${MAX_ZOOM})`, `__ix.record(${GESTURE_MS}, __ix.zoomCurve(${MAX_ZOOM}, ${MIN_ZOOM}, ${GESTURE_MS}))`);
      await measure("pan-overview", `__ix.wheelTo(${homeZoom})`, `__ix.record(${GESTURE_MS}, __ix.panCircle(240, ${GESTURE_MS}))`);
      await measure("pan-closeup", `__ix.wheelTo(${CLOSEUP_ZOOM})`, `__ix.record(${GESTURE_MS}, __ix.panLine(-1800, ${GESTURE_MS}))`);
    }

    return { controlFps, open, gestures, errors: cdp.consoleErrors.slice(0, 5) };
  } finally {
    cdp.close();
  }
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round(((v[m - 1] + v[m]) / 2) * 1000) / 1000;
};

/** Median of every numeric leaf across runs of the same shape. */
function medianOf(runs) {
  const walk = (objs) => {
    const first = objs[0];
    if (typeof first === "number" || first === null) return median(objs);
    if (typeof first !== "object") return first;
    return Object.fromEntries(Object.keys(first).map((k) => [k, walk(objs.map((o) => o?.[k]))]));
  };
  return walk(runs);
}

if (traceDir) mkdirSync(traceDir, { recursive: true });
const results = Object.fromEntries(targets.map((t) => [t.label, []]));
for (const n of sizes) {
  const runs = Object.fromEntries(targets.map((t) => [t.label, []]));
  for (let rep = 0; rep < reps; rep++) {
    // A B, then B A: neither build always runs first, or on the warmer machine.
    const order = rep % 2 ? [...targets].reverse() : targets;
    for (const t of order) {
      process.stdout.write(`[${t.label}] n=${n} rep ${rep + 1}/${reps} … `);
      try {
        const r = await runOnce(n, false, t);
        runs[t.label].push(r);
        const g = r.gestures;
        console.log(
          `control ${r.controlFps} · TTI ${r.open.tti}ms ${JSON.stringify(r.open.stages)} lt ${r.open.longTasks} · ` +
            Object.entries(g)
              .map(([k, v]) =>
                suite === "frame"
                  ? `${k} >8.3ms ${v.over8}/${v.frames} p95 ${v.workP95Ms}ms max ${v.workMaxMs} loaf ${v.loafs} commits ${v.commits}${v.commitsPerEvent !== null ? ` (${v.commitsPerEvent}/ev)` : ""}`
                  : `${k} ${v.avgFps}/${v.minFps}fps lt ${v.longTasks}`
              )
              .join(" · ") +
            (r.errors.length ? `  ERR ${r.errors.join(" | ").slice(0, 200)}` : "")
        );
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
      }
    }
  }
  for (const t of targets) {
    if (traceDir) {
      process.stdout.write(`[${t.label}] n=${n} traced (unscored) … `);
      try {
        await runOnce(n, true, t);
        console.log("done");
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
      }
    }
    const done = runs[t.label];
    if (!done.length) {
      results[t.label].push({ n, failed: true });
      continue;
    }
    const { controlFps, open, gestures } = medianOf(done.map(({ controlFps, open, gestures }) => ({ controlFps, open, gestures })));
    results[t.label].push({ n, reps: done.length, controlFps, open, gestures, runs: done });
  }
}
if (out) writeFileSync(out, JSON.stringify({ method: METHOD, suite, uncapped, labels: targets.map((t) => t.label), results }, null, 2));
process.exit(0);
