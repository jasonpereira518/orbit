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
 * `--trace-dir d` adds one more, unscored repetition that records each gesture as a Chrome trace
 * (`d/<label>-<n>-<gesture>.json`; DevTools → Performance → Load profile). Unscored because
 * tracing costs frames of its own.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "../dev/cdp.mjs";

export const METHOD = "constellation-interactions/1";

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
`;

/** The in-page gesture kit. */
const KIT = `
window.__ix = (() => {
  const pane = () => document.querySelector(".react-flow__pane");
  const centre = () => { const r = pane().getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const zoomNow = () => { const v = document.querySelector(".react-flow__viewport"); const m = v && getComputedStyle(v).transform.match(/matrix\\(([^,]+)/); return m ? Number(m[1]) : 1; };
  const wheel = (deltaY) => { const c = centre(); pane().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, view: window, clientX: c.x, clientY: c.y, deltaY, deltaMode: 0 })); };
  // React Flow: scale *= 2^(-deltaY * 0.002) for a pixel-mode wheel event (no ctrl).
  const wheelTo = (k) => { const cur = zoomNow(); if (Math.abs(Math.log2(k / cur)) > 1e-4) wheel(-Math.log2(k / cur) / 0.002); };
  const mouse = (type, target, x, y) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: type === "mouseup" ? 0 : 1 }));

  /** Record every frame for \`ms\`, calling driver.step(elapsed) inside each frame. */
  async function record(ms, driver) {
    const lt0 = window.__lt.length;
    const ts = [];
    driver.start?.();
    const t0 = performance.now();
    await new Promise((res) => {
      function f(t) {
        ts.push(t);
        const el = t - t0;
        if (el < ms) { driver.step(Math.min(el, ms)); requestAnimationFrame(f); } else { driver.step(ms); res(); }
      }
      requestAnimationFrame(f);
    });
    driver.end?.();
    // A long task still running when the window closes reports when it ends.
    await new Promise((r) => setTimeout(r, 120));
    const d = ts.slice(1).map((t, i) => t - ts[i]);
    const span = (ts.at(-1) - ts[0]) / 1000;
    const lts = window.__lt.slice(lt0).filter((l) => l.s >= t0 && l.s < t0 + ms);
    const sorted = [...d].sort((a, b) => a - b);
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

  return { zoomNow, wheelTo, record, zoomCurve, panCircle, panLine };
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
  const cdp = await launch({ width: 1440, height: 900, gpu: true, extraArgs: ["--ignore-certificate-errors"] });
  try {
    await cdp.goto("data:text/html,<body></body>");
    const controlFps = await cdp.evaluate(`new Promise((res) => { const ts = []; const t0 = performance.now(); (function f(t) { ts.push(t); if (t - t0 < 2000) requestAnimationFrame(f); else res(Math.round(((ts.length - 1) / ((ts.at(-1) - ts[0]) / 1000)) * 10) / 10); })(t0); })`);

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
      await evaluateWithin(cdp, setup);
      await cdp.sleep(SETTLE_MS);
      const file = traced_ ? join(traceDir, `${label}-${n}-${name}.json`) : null;
      gestures[name] = file ? await traced(cdp, expr, file) : await evaluateWithin(cdp, expr);
    };

    await measure("zoom-in", `__ix.wheelTo(${MIN_ZOOM})`, `__ix.record(${GESTURE_MS}, __ix.zoomCurve(${MIN_ZOOM}, ${MAX_ZOOM}, ${GESTURE_MS}))`);
    await measure("zoom-out", `__ix.wheelTo(${MAX_ZOOM})`, `__ix.record(${GESTURE_MS}, __ix.zoomCurve(${MAX_ZOOM}, ${MIN_ZOOM}, ${GESTURE_MS}))`);
    await measure("pan-overview", `__ix.wheelTo(${homeZoom})`, `__ix.record(${GESTURE_MS}, __ix.panCircle(240, ${GESTURE_MS}))`);
    await measure("pan-closeup", `__ix.wheelTo(${CLOSEUP_ZOOM})`, `__ix.record(${GESTURE_MS}, __ix.panLine(-1800, ${GESTURE_MS}))`);

    return { controlFps, open, gestures, errors: cdp.consoleErrors.slice(0, 5) };
  } finally {
    cdp.close();
  }
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round(((v[m - 1] + v[m]) / 2) * 10) / 10;
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
            Object.entries(g).map(([k, v]) => `${k} ${v.avgFps}/${v.minFps}fps lt ${v.longTasks}`).join(" · ") +
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
if (out) writeFileSync(out, JSON.stringify({ method: METHOD, labels: targets.map((t) => t.label), results }, null, 2));
process.exit(0);
