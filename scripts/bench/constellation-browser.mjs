/**
 * Measure the constellation in a real (headless, GPU-rasterised) Chrome at several network
 * sizes: mount cost, frame rate while idle / panning / zooming, the cost of the live updates
 * (hover spotlight, search), and heap and DOM size.
 *
 *   ORBIT_BENCH=1 npx next build --profile
 *   node scripts/bench/serve-static-bench.mjs 3417 &
 *   node scripts/bench/constellation-browser.mjs [sizes=100,500,1000,2500,5000,10000] [--label x] [--out f.json] [--soak]
 *
 * Every phase runs INSIDE the page on its own rAF loop — synthetic pointer and wheel events
 * dispatched from the frame callback — because CDP input costs ~110ms an event on a loaded
 * machine and would itself be the bottleneck. Frame times are rAF deltas: the main thread's
 * frame production, which is what a pan stutters on. React commit costs come from the
 * <Profiler> on the bench page (a `--profile` build), i.e. React DevTools' own numbers.
 *
 * `--soak` adds the few-minutes-of-interaction memory run: the pan/zoom/hover cycle on a loop,
 * with heap sampled after a forced GC so garbage and a leak can be told apart.
 */
import { writeFileSync } from "node:fs";
import { launch } from "../dev/cdp.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const sizes = (argv.find((a) => /^\d[\d,]*$/.test(a)) ?? "100,500,1000,2500,5000,10000")
  .split(",")
  .map(Number);
const label = flag("--label") ?? "run";
const out = flag("--out");
const soak = argv.includes("--soak");
const trace = argv.includes("--trace");
/**
 * `--ablate a+b`: strip visual layers before the page runs, to price each one. Diagnostic
 * only — it answers "which part of the sky costs the frames", not "is the chart fast".
 */
const ABLATIONS = {
  nonebula: `.constellation-nebula-wash{display:none!important}`,
  nodust: `.react-flow__node-starDust{display:none!important}`,
  noanim: `*,*::before,*::after{animation:none!important}`,
  nostarfield: `.constellation-starfield{display:none!important}`,
  notwinkle: `.constellation-twinkle-group{animation:none!important}`,
  nolabels: `.react-flow__node-contact p{display:none!important}`,
  noclusternames: `.react-flow__node-clusterLabel{display:none!important}`,
  noedgelayer: `.constellation-stage .react-flow__edges{will-change:auto!important}`,
  noedges: `.react-flow__edges,.react-flow__edge{display:none!important}`,
  novpwill: `.constellation-stage .react-flow__viewport{will-change:auto!important}`,
};
const ablate = (flag("--ablate") ?? "").split("+").filter(Boolean);
const ablationPrelude = ablate
  .map((a) => {
    const v = ABLATIONS[a];
    if (!v) throw new Error(`unknown ablation ${a}`);
    return v.includes("{") && !v.startsWith("const")
      ? `document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(v)}; document.head.appendChild(s); });`
      : v;
  })
  .join("\n");
const soakMs = Number(flag("--soak-ms") ?? 180_000);
const base = process.env.BENCH_URL ?? "http://localhost:3417/bench/constellation";

/** Installed before any page script: long tasks, and the frame the chart is revealed on. */
const PRELUDE = `
window.__lt = [];
try {
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ s: e.startTime, d: e.duration }); })
    .observe({ type: "longtask", buffered: true });
} catch {}
window.__ready = null;
(function poll() {
  const el = document.querySelector(".constellation-stage");
  // Any node, not a contact star: a large sky opens in the summary view, which mounts clusters
  // and one canvas of dots rather than stars.
  if (el && el.style.opacity === "1" && document.querySelector(".react-flow__node")) {
    window.__ready = performance.now();
    return;
  }
  requestAnimationFrame(poll);
})();
`;

/** The in-page measurement kit. `phase(name, ms, driver)` returns frame + commit stats. */
const KIT = `
window.__kit = (() => {
  const q = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const r1 = (x) => Math.round(x * 10) / 10;
  const pane = () => document.querySelector(".react-flow__pane");
  const center = () => { const r = pane().getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const mouse = (type, target, x, y, extra = {}) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: type === "mouseup" ? 0 : 1, ...extra }));

  async function phase(name, ms, driver) {
    const lt0 = window.__lt.length;
    const c0 = window.__bench.commits.length;
    const ts = [];
    const t0 = performance.now();
    await new Promise((res) => {
      function f(t) {
        ts.push(t);
        const el = t - t0;
        if (el < ms) { driver?.step?.(el); requestAnimationFrame(f); } else res();
      }
      driver?.start?.();
      requestAnimationFrame(f);
    });
    driver?.end?.();
    // Let the last frame's work land in the commit log before slicing it.
    await new Promise((r) => setTimeout(r, 50));
    const d = ts.slice(1).map((t, i) => t - ts[i]);
    const span = (ts.at(-1) - ts[0]) / 1000;
    const commits = window.__bench.commits.slice(c0).filter((c) => c.at >= t0);
    const lts = window.__lt.slice(lt0).filter((l) => l.s >= t0);
    const cm = commits.map((c) => c.actual);
    return {
      phase: name,
      fps: r1(d.length / span),
      p50: r1(q(d, 0.5)),
      p95: r1(q(d, 0.95)),
      max: r1(Math.max(0, ...d)),
      jankPct: r1((100 * d.filter((x) => x > 50).length) / Math.max(1, d.length)),
      longTaskMs: Math.round(lts.reduce((s, l) => s + l.d, 0)),
      commits: commits.length,
      commitMs: Math.round(cm.reduce((s, x) => s + x, 0)),
      commitMax: r1(Math.max(0, ...cm)),
      commitP50: r1(q(cm, 0.5)),
    };
  }

  const idle = () => ({});

  /** Drag the sky around a circle — a steady pan, one pointer move per frame. */
  function pan() {
    let c;
    return {
      start() { c = center(); mouse("mousedown", pane(), c.x, c.y); },
      step(el) {
        const a = (el / 2000) * Math.PI * 2;
        mouse("mousemove", window, c.x + Math.cos(a) * 220 - 220, c.y + Math.sin(a) * 160, { buttons: 1 });
      },
      end() { mouse("mouseup", window, c.x, c.y); },
    };
  }

  /** Wheel in, then out, then in: one wheel tick per frame, ~2.2x either side of home. */
  function zoom() {
    let c;
    return {
      start() { c = center(); },
      step(el) {
        const deltaY = -15 * Math.sin((el / 2000) * Math.PI * 2);
        pane().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, view: window, clientX: c.x, clientY: c.y, deltaY, deltaMode: 0 }));
      },
    };
  }

  /** Visible hover targets — stars, or clusters in the summary view — nearest the centre first. */
  function visibleStars(limit = 40) {
    const vw = innerWidth, vh = innerHeight;
    const stars = document.querySelectorAll(".react-flow__node-contact");
    return [...(stars.length ? stars : document.querySelectorAll(".react-flow__node-clusterLabel"))]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.left > 0 && r.top > 0 && r.right < vw && r.bottom < vh)
      .sort((a, b) => Math.hypot(a.r.left - vw / 2, a.r.top - vh / 2) - Math.hypot(b.r.left - vw / 2, b.r.top - vh / 2))
      .slice(0, limit)
      .map(({ el }) => el);
  }

  /** Move the pointer from star to star every 150ms — the hover spotlight, as a live update. */
  function hover() {
    let stars = [], i = 0, prev = null, last = -1e9;
    return {
      start() { stars = visibleStars(); },
      step(el) {
        if (!stars.length || el - last < 150) return;
        last = el;
        const next = stars[i++ % stars.length];
        const r = next.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (prev) prev.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, view: window, relatedTarget: next, clientX: x, clientY: y }));
        next.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, view: window, relatedTarget: prev ?? pane(), clientX: x, clientY: y }));
        prev = next;
      },
      end() { if (prev) prev.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, view: window, relatedTarget: pane() })); },
    };
  }

  /** Type a query into the chart's search one key every 120ms, as a person would. */
  function search(text) {
    let input, last = -1e9, k = 0;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    return {
      start() { input = document.querySelector('input[placeholder^="Search name"]'); input?.focus(); },
      step(el) {
        if (!input || k > text.length || el - last < 120) return;
        last = el;
        setter.call(input, text.slice(0, k++));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
    };
  }

  const currentZoom = () => { const v = document.querySelector(".react-flow__viewport"); const m = v && getComputedStyle(v).transform.match(/matrix\\(([^,]+)/); return m ? Number(m[1]) : 1; };

  /**
   * Wheel in at the centre, one tick a frame, until the camera reaches the target, then hold. A
   * large sky opens far out, so this is how the close-up view — real stars, labels, lines — gets
   * measured at all, and its frames include the cost of crossing into it.
   */
  function zoomTo(target) {
    let c;
    return {
      start() { c = center(); },
      step() {
        if (currentZoom() >= target) return;
        pane().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, view: window, clientX: c.x, clientY: c.y, deltaY: -60, deltaMode: 0 }));
      },
    };
  }

  function dom() {
    return {
      contactNodes: document.querySelectorAll(".react-flow__node-contact").length,
    summary: Boolean(document.querySelector(".react-flow__node-starDust")),
      allNodes: document.querySelectorAll(".react-flow__node").length,
      edges: document.querySelectorAll(".react-flow__edge").length,
      elements: document.getElementsByTagName("*").length,
      zoom: (() => { const v = document.querySelector(".react-flow__viewport"); const m = v && getComputedStyle(v).transform.match(/matrix\\(([^,]+)/); return m ? r1(Number(m[1]) * 100) / 100 : null; })(),
    };
  }

  return { phase, idle, pan, zoom, zoomTo, hover, search, dom };
})();
`;

/**
 * The Performance panel's "Bottom-up" view for one phase: renderer main-thread time by event
 * name. What the frame budget is actually spent on — script, style recalc, layout, paint.
 */
async function traced(cdp, expr) {
  const events = [];
  const onData = (p) => events.push(...p.value);
  cdp.onEvent?.("Tracing.dataCollected", onData);
  const done = new Promise((r) => cdp.onEvent?.("Tracing.tracingComplete", r));
  await cdp.send("Tracing.start", {
    traceConfig: {
      includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink", "cc", "gpu"],
      recordMode: "recordAsMuchAsPossible",
    },
    transferMode: "ReportEvents",
  });
  const result = await cdp.evaluate(expr);
  await cdp.send("Tracing.end");
  await done;
  const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
  // Self time per event name, as the Bottom-up tab computes it: each complete event's
  // duration minus the durations of the events nested directly inside it. Nothing is
  // counted twice, so the buckets add up to the main thread's busy time.
  const xs = events
    .filter((e) => main && e.pid === main.pid && e.tid === main.tid && e.ph === "X" && e.dur)
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const self = {};
  const stack = [];
  let busy = 0;
  for (const e of xs) {
    while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= e.ts) stack.pop();
    const parent = stack.at(-1);
    if (parent) self[parent.name] = (self[parent.name] ?? 0) - e.dur / 1000;
    else busy += e.dur / 1000;
    self[e.name] = (self[e.name] ?? 0) + e.dur / 1000;
    stack.push(e);
  }
  const trace = { busy: Math.round(busy) };
  for (const [name, ms] of Object.entries(self).sort((a, b) => b[1] - a[1]).slice(0, 9)) {
    trace[name] = Math.round(ms);
  }
  return { ...result, trace };
}

/**
 * Evaluate with a deadline.
 *
 * Every phase resolves from inside a rAF loop, so a page that stops producing frames (a
 * renderer that crashed, or one so far behind that the tab is unresponsive) leaves the
 * promise pending and `Runtime.evaluate` waiting forever. One 5,000-contact run hung for 25
 * minutes that way. A wedged page has to fail loudly and let the rest of the matrix run.
 */
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

async function metrics(cdp) {
  const { metrics: m } = await cdp.send("Performance.getMetrics");
  const get = (n) => m.find((x) => x.name === n)?.value ?? 0;
  return {
    heapMB: Math.round((get("JSHeapUsedSize") / 1048576) * 10) / 10,
    domNodes: get("Nodes"),
    listeners: get("JSEventListeners"),
    layoutObjects: get("LayoutObjects"),
  };
}

/**
 * Composited layers right now, as the Layers panel counts them. The number GPU memory follows:
 * too many and Chrome starts evicting tiles, which is what showed as the sidebar flashing blank.
 */
async function layerCount(cdp) {
  const tree = new Promise((resolve) => {
    cdp.onEvent("LayerTree.layerTreeDidChange", (p) => {
      if (p.layers) resolve(p.layers.length);
    });
  });
  await cdp.send("LayerTree.enable");
  const count = await Promise.race([tree, cdp.sleep(3000).then(() => null)]);
  await cdp.send("LayerTree.disable");
  return count;
}

async function gcMetrics(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.sleep(300);
  await cdp.send("HeapProfiler.collectGarbage");
  return metrics(cdp);
}

async function runSize(n) {
  const cdp = await launch({ width: 1440, height: 900, gpu: true, extraArgs: ["--enable-precise-memory-info"] });
  try {
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.enable");
    // Control: the same browser on an empty page. If this is not ~60fps the machine, not the
    // chart, is the ceiling for every number below.
    await cdp.goto("data:text/html,<body></body>");
    const control = await cdp.evaluate(`new Promise((res) => { const ts = []; const t0 = performance.now(); (function f(t) { ts.push(t); if (t - t0 < 3000) requestAnimationFrame(f); else res(Math.round(((ts.length - 1) / ((ts.at(-1) - ts[0]) / 1000)) * 10) / 10); })(t0); })`);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PRELUDE + "\n" + ablationPrelude });
    const navAt = Date.now();
    await cdp.goto(`${base}?n=${n}`);
    await cdp.waitFor("window.__ready !== null && !!window.__bench", 180_000);
    await cdp.evaluate(KIT);

    const mount = await cdp.evaluate(`(() => {
      const b = window.__bench, ready = window.__ready;
      const cm = b.commits.filter((c) => c.at <= ready + 50);
      const lts = window.__lt.filter((l) => l.s >= b.startedAt - 5 && l.s <= ready + 50);
      return {
        payloadMs: Math.round(b.payloadMs),
        mountToRevealMs: Math.round(ready - b.startedAt),
        mountCommits: cm.length,
        mountCommitMs: Math.round(cm.reduce((s, c) => s + c.actual, 0)),
        mountCommitMax: Math.round(Math.max(0, ...cm.map((c) => c.actual))),
        mountLongTaskMs: Math.round(lts.reduce((s, l) => s + l.d, 0)),
        mountLongestTaskMs: Math.round(Math.max(0, ...lts.map((l) => l.d))),
      };
    })()`);
    mount.wallToRevealMs = Date.now() - navAt;

    // Let the intro hand over and the enter animations finish before timing anything.
    await cdp.sleep(3500);
    const gpu = await cdp.evaluate(`(() => { const gl = document.createElement("canvas").getContext("webgl"); const ext = gl && gl.getExtension("WEBGL_debug_renderer_info"); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "none"; })()`);
    const settled = {
      ...(await cdp.evaluate("__kit.dom()")),
      ...(await gcMetrics(cdp)),
      layers: await layerCount(cdp),
    };

    const run = (expr) => (trace ? traced(cdp, expr) : evaluateWithin(cdp, expr));
    const phases = [];
    phases.push(await run(`__kit.phase("idle", 5000, __kit.idle())`));
    phases.push(await run(`__kit.phase("pan", 5000, __kit.pan())`));
    phases.push(await run(`__kit.phase("zoom", 5000, __kit.zoom())`));
    phases.push(await run(`__kit.phase("hover", 4000, __kit.hover())`));
    phases.push(await run(`__kit.phase("search", 3000, __kit.search("google"))`));
    // Clear the search so the soak starts from the unfiltered sky.
    await evaluateWithin(cdp, `__kit.phase("search-clear", 1500, __kit.search(""))`);
    // Close up: wheel in to 0.3 (the crossing is in its frames), let it settle, and measure there.
    phases.push(await run(`__kit.phase("zoomin", 4000, __kit.zoomTo(0.3))`));
    await cdp.sleep(1500);
    const closeUp = await cdp.evaluate("__kit.dom()");
    phases.push({ ...(await run(`__kit.phase("pan@0.3", 5000, __kit.pan())`)), stars: closeUp.contactNodes, zoomAt: closeUp.zoom });
    phases.push(await run(`__kit.phase("hover@0.3", 4000, __kit.hover())`));
    const after = { ...(await cdp.evaluate("__kit.dom()")), ...(await gcMetrics(cdp)) };

    let soakRun = null;
    if (soak) {
      const samples = [];
      const t0 = Date.now();
      samples.push({ t: 0, ...(await gcMetrics(cdp)) });
      const cycle = [];
      while (Date.now() - t0 < soakMs) {
        for (const [name, ms] of [["pan", 4000], ["zoom", 4000], ["hover", 4000], ["idle", 3000]]) {
          cycle.push(await evaluateWithin(cdp, `__kit.phase(${JSON.stringify(name)}, ${ms}, __kit.${name}())`));
        }
        samples.push({ t: Math.round((Date.now() - t0) / 1000), ...(await metrics(cdp)) });
      }
      samples.push({ t: Math.round((Date.now() - t0) / 1000), gc: true, ...(await gcMetrics(cdp)) });
      const byPhase = {};
      for (const p of cycle) (byPhase[p.phase] ??= []).push(p.fps);
      soakRun = {
        seconds: Math.round((Date.now() - t0) / 1000),
        samples,
        meanFps: Object.fromEntries(Object.entries(byPhase).map(([k, v]) => [k, Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10])),
      };
    }

    return { n, label, gpu, controlFps: control, mount, settled, phases, after, soak: soakRun, errors: cdp.consoleErrors.slice(0, 5) };
  } finally {
    cdp.close();
  }
}

const results = [];
for (const n of sizes) {
  process.stdout.write(`\n[${label}] n=${n} … `);
  let r;
  try {
    r = await runSize(n);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    results.push({ n, label, failed: String(err.message) });
    continue;
  }
  results.push(r);
  console.log(`control ${r.controlFps}fps · gpu ${r.gpu} · revealed in ${r.mount.mountToRevealMs}ms (${r.settled.contactNodes} star DOM nodes${r.settled.summary ? " [summary]" : ""}, ${r.settled.layers} layers, zoom ${r.settled.zoom}, heap ${r.settled.heapMB}MB, ${r.settled.domNodes} DOM nodes)`);
  for (const p of r.phases) {
    console.log(
      `   ${p.phase.padEnd(7)} ${String(p.fps).padStart(5)} fps  p50 ${String(p.p50).padStart(5)}  p95 ${String(p.p95).padStart(6)}  max ${String(p.max).padStart(6)}  jank ${String(p.jankPct).padStart(5)}%  ` +
        `longtasks ${String(p.longTaskMs).padStart(5)}ms  commits ${String(p.commits).padStart(3)} / ${String(p.commitMs).padStart(5)}ms (max ${p.commitMax})` +
        (p.stars !== undefined ? `  [${p.stars} stars at zoom ${p.zoomAt}]` : "")
    );
  }
  if (trace) for (const p of r.phases) console.log(`   trace ${p.phase.padEnd(7)} ${JSON.stringify(p.trace)}`);
  if (r.soak) console.log(`   soak ${r.soak.seconds}s heap after GC ${r.soak.samples[0].heapMB} → ${r.soak.samples.at(-1).heapMB}MB, listeners ${r.soak.samples[0].listeners} → ${r.soak.samples.at(-1).listeners}; mean fps ${JSON.stringify(r.soak.meanFps)}`);
  if (r.errors.length) console.log(`   console errors: ${r.errors.join(" | ").slice(0, 300)}`);
}
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
process.exit(0);
