/**
 * What recording a meeting costs the laptop: browser-wide CPU, memory, and the recorder's
 * message rates, while a real tab is being shared.
 *
 *   node scripts/bench/meeting-recorder.mjs --ab before=http://localhost:3101,after=http://localhost:3102 \
 *     --reps 2 --scenario-ms 120000 --out meeting-ab.json
 *   node scripts/bench/meeting-recorder.mjs --ab after=http://localhost:3102 --soak-ms 600000
 *
 * Each URL is a demo-mode `next dev` of one build (no `.env.local`), started with
 *   ORBIT_DEEPGRAM=off ORBIT_MANAGED_OPENAI_API_KEY=bench-fake ORBIT_MANAGED_ANTHROPIC_API_KEY=bench-fake
 * so Start is enabled and the demo account (a Free plan: no meeting hours) is not refused at
 * session start. The browser still streams to the live socket, which the prelude fakes. Use a copy of the tree per build, each with its own `.data`.
 *
 * REAL CAPTURE, NOT A STUB. Chrome runs new-headless (`--headful` for a window; see
 * `headful` below for why that is not the default) with
 * `--auto-select-tab-capture-source-by-title`, so `getDisplayMedia` really captures a second
 * tab ("Orbit Bench Call") that plays speech-like audio — the capturer, the disabled video
 * track and the audio service are all billed. The mic is Chrome's fake device.
 *
 * Nothing leaves the machine: a prelude replaces Deepgram's WebSocket with a fake that counts
 * what it is sent and answers with interim/final results paced by the audio it received, and
 * CDP `Fetch` fulfils `stream-token` and `chunks`. Segments and the session go to the local
 * demo server.
 *
 * Per run (fresh browser, one build): idle baseline (call playing, not recording) → A
 * recording with /capture visible → B recording with Orbit in a background tab → C paused
 * with the share kept → resume check. CPU is the sum of every Chrome process's cpuTime
 * (SystemInfo.getProcessInfo), so capture, GPU and audio-service costs count, not just JS.
 * `--ab` interleaves builds and alternates which goes first; reports medians.
 *
 * Run under `caffeinate -dimsu`, on AC power, with nothing else heavy running.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CALL_TITLE = "Orbit Bench Call";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const builds = (flag("ab", "after=http://localhost:3102") || "")
  .split(",")
  .map((pair) => {
    const [label, ...rest] = pair.split("=");
    return { label, base: rest.join("=") };
  });
const reps = Number(flag("reps", "1"));
const scenarioMs = Number(flag("scenario-ms", "120000"));
const baselineMs = Number(flag("baseline-ms", String(Math.round(scenarioMs / 2))));
const warmupMs = Number(flag("warmup-ms", "15000"));
const soakMs = Number(flag("soak-ms", "0"));
const out = flag("out", null);
/**
 * Headful Chrome is only as visible as its window: one behind other apps, on another Space or
 * under a locked screen reports `visibilityState: "hidden"` and runs no rAF, which silently
 * turns scenario A into a second background run. New-headless is always visible (rAF runs)
 * and still really captures the call tab, so it is the default.
 */
const headful = argv.includes("--headful");
/** Diagnosis only: with --soak-ms, diff heap snapshots (first sample vs end) by constructor. */
const heapDiff = argv.includes("--heap-diff");
/** Diagnosis only: with --heap-diff, also write the end-of-soak snapshot here (for retainer paths in DevTools). */
const saveSnapshot = flag("save-snapshot", null);
/** Diagnosis only: CPU-profile the recorder tab during scenario B and print the top self time. */
const profile = argv.includes("--profile");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

// ── The "call": bandpassed noise gated by a ~4 Hz syllable envelope, with pauses ─────────
const CALL_HTML = `<!doctype html><title>${CALL_TITLE}</title><body style="font:16px system-ui">call audio<script>
const c = new AudioContext();
const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
const src = c.createBufferSource(); src.buffer = buf; src.loop = true;
const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 900; bp.Q.value = 0.8;
const env = c.createGain(); env.gain.value = 0;
src.connect(bp).connect(env).connect(c.destination); src.start();
// 6s talking, 2s quiet, repeating — syllables at ~4 Hz while talking.
const t0 = c.currentTime + 0.1;
for (let s = 0; s < 4 * 60 * 60 * 4; s++) {
  const t = t0 + s * 0.25, inTalk = (t - t0) % 8 < 6;
  env.gain.setValueAtTime(inTalk ? 0.35 : 0, t);
  env.gain.setValueAtTime(inTalk ? 0.05 : 0, t + 0.16);
}
</script>`;

// ── Prelude for the recorder tab: counters + fake Deepgram ───────────────────────────────
const PRELUDE = `(() => {
  const b = (window.__bench = { worklet: 0, sends: 0, bytes: 0, audioMs: 0, gdm: 0, results: 0 });
  const md = navigator.mediaDevices;
  if (md && md.getDisplayMedia) {
    const orig = md.getDisplayMedia.bind(md);
    md.getDisplayMedia = (o) => { b.gdm++; return orig(o).catch((e) => { b.gdmError = e.name + ": " + e.message; throw e; }); };
  }
  if (window.AudioWorkletNode) {
    const Orig = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Orig {
      constructor(...a) { super(...a); this.port.addEventListener("message", () => { b.worklet++; }); }
    };
  }
  const Real = window.WebSocket;
  const tick = new MessageChannel();
  const queue = [];
  tick.port1.onmessage = () => { const fn = queue.shift(); if (fn) fn(); };
  const later = (fn) => { queue.push(fn); tick.port2.postMessage(0); };
  const WORDS = "so the plan for next quarter is to ship the pilot with three design partners and then expand".split(" ");
  class FakeDeepgram extends EventTarget {
    constructor(url, protocols) {
      super();
      this.url = url; this.protocol = "bearer"; this.readyState = 0; this.bufferedAmount = 0;
      this.binaryType = "blob"; this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this.audioMs = 0; this.lastInterim = 0; this.lastFinal = 0; this.w = 0;
      setTimeout(() => { this.readyState = 1; this.fire("open", new Event("open")); }, 50);
    }
    fire(type, ev) { const h = this["on" + type]; if (h) h.call(this, ev); this.dispatchEvent(ev); }
    emit(final) {
      const from = this.lastFinal, to = this.audioMs, n = Math.max(1, Math.round((to - from) / 400));
      const words = [];
      for (let i = 0; i < n; i++) {
        const s = (from + ((to - from) * i) / n) / 1000, e = (from + ((to - from) * (i + 1)) / n) / 1000;
        words.push({ word: WORDS[(this.w + i) % WORDS.length], start: s, end: e, speaker: Math.floor(from / 15000) % 2 });
      }
      if (final) { this.w += n; this.lastFinal = to; }
      b.results++;
      const msg = JSON.stringify({ type: "Results", is_final: final, speech_final: final, start: from / 1000, duration: (to - from) / 1000,
        channel: { alternatives: [{ transcript: words.map((x) => x.word).join(" "), words }] } });
      later(() => this.fire("message", new MessageEvent("message", { data: msg })));
    }
    send(data) {
      if (this.readyState !== 1) return;
      if (typeof data === "string") {
        if (data.includes("CloseStream")) {
          later(() => this.fire("message", new MessageEvent("message", { data: JSON.stringify({ type: "Metadata" }) })));
          later(() => this.close(1000));
        }
        return;
      }
      const n = data.byteLength ?? 0;
      b.sends++; b.bytes += n; this.audioMs += n / 32; b.audioMs += n / 32;
      if (this.audioMs - this.lastFinal >= 2500) { this.emit(true); this.lastInterim = this.audioMs; }
      else if (this.audioMs - this.lastInterim >= 300) { this.emit(false); this.lastInterim = this.audioMs; }
    }
    close(code = 1000) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      later(() => this.fire("close", new CloseEvent("close", { code })));
    }
  }
  function Socket(url, protocols) {
    // Intercepted, never dialled: any Deepgram host gets the fake.
    return new URL(String(url), location.href).hostname.endsWith(".deepgram.com") ? new FakeDeepgram(url, protocols) : new Real(url, protocols);
  }
  Object.assign(Socket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  Socket.prototype = Real.prototype;
  window.WebSocket = Socket;
})();`;

// ── CDP over the browser endpoint, flat sessions ─────────────────────────────────────────
async function launchBrowser() {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), "orbit-meeting-bench-"));
  const proc = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      ...(headful ? [] : ["--headless=new"]),
      "--no-first-run",
      "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required",
      `--auto-select-tab-capture-source-by-title=${CALL_TITLE}`,
      "--use-fake-device-for-media-stream",
      // A window covered by another app would otherwise count as hidden and skew scenario A.
      // Tab switches (scenario B) still hide the page as usual.
      "--disable-backgrounding-occluded-windows",
      "--enable-precise-memory-info",
      "--window-size=1280,860",
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  let version;
  for (let i = 0; i < 100 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(200);
    }
  }
  if (!version) throw new Error("Chrome did not start");
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    } else if (m.method) {
      for (const l of listeners) if (l.method === m.method && (!l.sessionId || l.sessionId === m.sessionId)) l.fn(m.params);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const on = (method, fn, sessionId) => listeners.push({ method, fn, sessionId });
  const close = () => {
    try {
      ws.close();
    } catch {}
    proc.kill();
  };
  return { send, on, close, listeners };
}

async function openTab(cdp, { prelude } = {}) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method, params) => cdp.send(method, params, sessionId);
  await s("Page.enable");
  await s("Runtime.enable");
  await s("Performance.enable", { timeDomain: "timeTicks" });
  if (prelude) await s("Page.addScriptToEvaluateOnNewDocument", { source: prelude });
  const evaluate = async (expression) => {
    const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.value;
  };
  const goto = async (to) => {
    const loaded = new Promise((r) => cdp.on("Page.loadEventFired", r, sessionId));
    await s("Page.navigate", { url: to });
    await Promise.race([loaded, sleep(120000)]);
  };
  const waitFor = async (expr, timeout = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await evaluate(expr).catch(() => false)) return true;
      await sleep(250);
    }
    throw new Error(`timeout waiting for ${expr}`);
  };
  const click = async (x, y) => {
    await s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await s("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await s("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const buttonExpr = (text) =>
    `[...document.querySelectorAll("button")].find((e) => e.textContent.trim().includes(${JSON.stringify(text)}))`;
  const clickButton = async (text) => {
    const rect = await evaluate(
      `(() => { const el = ${buttonExpr(text)}; if (!el || el.disabled) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`
    );
    if (!rect) throw new Error(`no enabled button "${text}"`);
    await sleep(100);
    await click(rect.x, rect.y);
  };
  const metrics = async () => {
    const { metrics: list } = await s("Performance.getMetrics");
    return Object.fromEntries(list.map((m) => [m.name, m.value]));
  };
  const gcHeap = async () => {
    await s("HeapProfiler.collectGarbage");
    await s("HeapProfiler.collectGarbage");
    return (await metrics()).JSHeapUsedSize;
  };
  return { targetId, sessionId, s, evaluate, goto, waitFor, clickButton, buttonExpr, metrics, gcHeap };
}

/** Hide or show the recorder: its own window, minimized for "Orbit in the background". */
async function setRecorderHidden(cdp, rec, hidden) {
  const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: rec.targetId });
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: hidden ? "minimized" : "normal" } });
  await rec.waitFor(`document.visibilityState === ${JSON.stringify(hidden ? "hidden" : "visible")}`, 10000);
}

async function processSnapshot(cdp) {
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
  return processInfo;
}

function rssMb(pids) {
  if (!pids.length) return 0;
  try {
    const text = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" });
    return text
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter(Boolean)
      .reduce((a, b) => a + b, 0) / 1024;
  } catch {
    return 0;
  }
}

/** One measurement window: CPU by process type, RSS, recorder-tab main thread, counters. */
async function measure(cdp, rec, ms) {
  const p0 = await processSnapshot(cdp);
  const m0 = await rec.metrics();
  const c0 = await rec.evaluate("({ ...window.__bench })");
  const t0 = Date.now();
  const rss = [];
  while (Date.now() - t0 < ms) {
    await sleep(Math.min(5000, ms - (Date.now() - t0)));
    rss.push(rssMb((await processSnapshot(cdp)).map((p) => p.id)));
  }
  const wall = (Date.now() - t0) / 1000;
  const p1 = await processSnapshot(cdp);
  const m1 = await rec.metrics();
  const c1 = await rec.evaluate("({ ...window.__bench })");
  const before = new Map(p0.map((p) => [p.id, p.cpuTime]));
  const byType = {};
  let total = 0;
  for (const p of p1) {
    const d = p.cpuTime - (before.get(p.id) ?? 0);
    const type = p.type.replace(/\.mojom\..*$/, "");
    byType[type] = (byType[type] ?? 0) + d;
    total += d;
  }
  const pct = (sec) => Math.round((sec / wall) * 1000) / 10;
  const rate = (k) => Math.round(((c1[k] ?? 0) - (c0[k] ?? 0)) / wall);
  return {
    cpuPct: pct(total),
    cpuByType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, pct(v)])),
    rssMb: Math.round(median(rss)),
    recorderMainThreadPct: pct((m1.TaskDuration ?? 0) - (m0.TaskDuration ?? 0)),
    recorderScriptPct: pct((m1.ScriptDuration ?? 0) - (m0.ScriptDuration ?? 0)),
    heapMb: Math.round(((m1.JSHeapUsedSize ?? 0) / 1048576) * 10) / 10,
    workletMsgsPerSec: rate("worklet"),
    wsSendsPerSec: rate("sends"),
    wsBytesPerSec: rate("bytes"),
    streamedAudioMs: Math.round((c1.audioMs ?? 0) - (c0.audioMs ?? 0)),
    wallMs: Math.round(wall * 1000),
  };
}

async function setupRun(base) {
  const cdp = await launchBrowser();
  try {
    return await prepare(cdp, base);
  } catch (err) {
    cdp.close();
    throw err;
  }
}

async function prepare(cdp, base) {
  const origin = new URL(base).origin;
  await cdp.send("Browser.grantPermissions", { origin, permissions: ["audioCapture"] });
  const call = await openTab(cdp);
  await call.goto("data:text/html," + encodeURIComponent(CALL_HTML));
  const rec = await openTab(cdp, { prelude: PRELUDE });

  // Keep stream-token and chunk uploads on this machine.
  let chunks = 0;
  await rec.s("Fetch.enable", {
    patterns: [
      { urlPattern: "*/api/capture/meetings/*/stream-token*", requestStage: "Request" },
      { urlPattern: "*/api/capture/meetings/*/chunks*", requestStage: "Request" },
    ],
  });
  cdp.on(
    "Fetch.requestPaused",
    (p) => {
      const url = new URL(p.request.url);
      let body;
      if (url.pathname.endsWith("/stream-token")) {
        body = { accessToken: "bench", expiresIn: 3600, keyterms: [], remainingSeconds: 36000, warn: false };
      } else {
        chunks++;
        body = { seq: Number(url.searchParams.get("seq") ?? 0), text: "", engine: "deepgram", duplicate: false };
      }
      void rec.s("Fetch.fulfillRequest", {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "application/json" }],
        body: Buffer.from(JSON.stringify(body)).toString("base64"),
      });
    },
    rec.sessionId
  );

  await rec.goto(`${base}/capture?mode=meeting`);
  // The first visit compiles the route in dev; Start appears once hydrated.
  await rec.waitFor(`!!${rec.buttonExpr("Start listening")}`, 120000).catch(async (err) => {
    console.error((await rec.evaluate("document.body.innerText")).slice(0, 1500));
    throw err;
  });
  try {
    await rec.waitFor(`!${rec.buttonExpr("Start listening")}.disabled`, 30000);
  } catch {
    throw new Error("Start listening stays disabled — start the server with the bench env (see header)");
  }
  return { cdp, call, rec, chunks: () => chunks };
}

/**
 * Click Start until the share comes up. Chrome's title-based auto-select now and then
 * refuses the request ("Nothing was shared"); a second click almost always takes.
 */
async function startRecording(rec) {
  for (let attempt = 1; ; attempt++) {
    await rec.clickButton("Start listening");
    const ok = await rec
      .waitFor(`!!${rec.buttonExpr("Pause")} || !!window.__bench.gdmError`, 20000)
      .then(() => rec.evaluate("!window.__bench.gdmError"))
      .catch(() => false);
    if (ok) return isRecording(rec);
    const why = await rec.evaluate("window.__bench.gdmError ?? 'no recording state'");
    if (attempt >= 3) throw new Error(`share never started: ${why}`);
    console.error(`start attempt ${attempt} failed (${why}); retrying`);
    await rec.evaluate("delete window.__bench.gdmError");
    await sleep(2000);
  }
}

const isRecording = (rec) =>
  rec.waitFor(`!!${rec.buttonExpr("Pause")} && !${rec.buttonExpr("Resume recording")}`, 30000).catch(async (err) => {
    console.error(JSON.stringify(await rec.evaluate("({ bench: window.__bench, text: document.querySelector('main')?.innerText.slice(0, 1500) })")));
    throw err;
  });

async function runOnce(build) {
  const { cdp, rec, chunks } = await setupRun(build.base);
  try {
    const result = { build: build.label };
    // Let the first-visit compile, hydration fetches and prefetches finish before the idle baseline.
    await sleep(20000);
    result.baseline = await measure(cdp, rec, baselineMs);

    await startRecording(rec);
    const recStart = Date.now();
    await sleep(warmupMs);
    result.A_visible = await measure(cdp, rec, scenarioMs);
    // The meters' bar transforms, sampled twice: they must differ (moving), not just be set.
    const meterBars = `JSON.stringify([...document.querySelectorAll(".origin-left")].map((e) => e.style.transform))`;
    const bars1 = await rec.evaluate(meterBars);
    await sleep(700);
    result.A_visible.meterBars = [bars1, await rec.evaluate(meterBars)];
    result.A_visible.page = await rec.evaluate(`new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); }; requestAnimationFrame(f); setTimeout(() => r({ vis: document.visibilityState, focus: document.hasFocus(), rafPerSec: n }), 1100); })`);
    result.A_visible.meterMoving = bars1 !== result.A_visible.meterBars[1] && await rec.evaluate(
      `[...document.querySelectorAll("[style*='scale']")].some((e) => { const m = /scaleX?\\(([\\d.]+)/.exec(e.style.transform); return m && Number(m[1]) > 0.02; })`
    );

    await setRecorderHidden(cdp, rec, true);
    await sleep(3000);
    if (profile) {
      await rec.s("Profiler.enable");
      await rec.s("Profiler.setSamplingInterval", { interval: 500 });
      await rec.s("Profiler.start");
    }
    result.B_background = await measure(cdp, rec, scenarioMs);
    if (profile) result.B_profile = topSelfTime((await rec.s("Profiler.stop")).profile);

    await setRecorderHidden(cdp, rec, false);
    await sleep(1500);
    const streamedBeforePause = await rec.evaluate("window.__bench.audioMs");
    const recordedMs = Date.now() - recStart;
    await rec.clickButton("Pause");
    await rec.waitFor(`!!${rec.buttonExpr("Resume recording")}`, 15000);
    await sleep(3000);
    result.C_paused = await measure(cdp, rec, Math.round(scenarioMs / 2));

    await rec.clickButton("Resume recording");
    await isRecording(rec);
    await sleep(5000);
    const counters = await rec.evaluate("({ ...window.__bench })");
    result.checks = {
      getDisplayMediaCalls: counters.gdm,
      // Live audio streamed vs wall-clock recording time, up to the pause (warm-up included).
      streamedVsWallPct: Math.round((streamedBeforePause / recordedMs) * 1000) / 10,
      deepgramResults: counters.results,
      chunkUploads: chunks(),
      resumedStreaming: counters.audioMs > streamedBeforePause,
    };
    return result;
  } finally {
    cdp.close();
  }
}

/** Self size and count per node name (constructor / string / closure), from a full heap snapshot. */
async function heapByConstructor(cdp, rec, save = null) {
  const chunks = [];
  const on = (p) => chunks.push(p.chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", on, rec.sessionId);
  await rec.s("HeapProfiler.enable");
  await rec.s("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  const listener = cdp.listeners?.find((l) => l.fn === on);
  if (listener) listener.method = "(done)";
  const raw = chunks.join("");
  if (save) writeFileSync(save, raw);
  const snap = JSON.parse(raw);
  const f = snap.snapshot.meta.node_fields, types = snap.snapshot.meta.node_types[0];
  const iType = f.indexOf("type"), iName = f.indexOf("name"), iSize = f.indexOf("self_size"), n = f.length;
  const out = new Map();
  for (let i = 0; i < snap.nodes.length; i += n) {
    const key = `${types[snap.nodes[i + iType]]}:${snap.strings[snap.nodes[i + iName]].slice(0, 60)}`;
    const e = out.get(key) ?? { size: 0, count: 0 };
    e.size += snap.nodes[i + iSize];
    e.count++;
    out.set(key, e);
  }
  return out;
}

function topSelfTime(p) {
  const dt = new Map();
  for (let i = 0; i < p.samples.length; i++) dt.set(p.samples[i], (dt.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0));
  const by = new Map();
  for (const n of p.nodes) {
    const us = dt.get(n.id) ?? 0;
    const f = n.callFrame;
    const key = `${f.functionName || "(anon)"} ${f.url.split("/").slice(-1)[0]}:${f.lineNumber}`;
    by.set(key, (by.get(key) ?? 0) + us);
  }
  return [...by].filter(([k]) => !k.startsWith("(idle)")).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, us]) => `${(us / 1000).toFixed(0)}ms ${k}`);
}

async function soak(build) {
  const { cdp, rec } = await setupRun(build.base);
  try {
    await startRecording(rec);
    await setRecorderHidden(cdp, rec, true);
    const samples = [];
    const t0 = Date.now();
    let firstSnapshot = null;
    while (Date.now() - t0 < soakMs) {
      const w = await measure(cdp, rec, 30000);
      if (heapDiff && !firstSnapshot) firstSnapshot = await heapByConstructor(cdp, rec);
      samples.push({ atS: Math.round((Date.now() - t0) / 1000), heapMbAfterGc: Math.round((await rec.gcHeap()) / 104857.6) / 10, cpuPct: w.cpuPct, rssMb: w.rssMb });
      console.error(`[${build.label}] soak ${samples.at(-1).atS}s heap ${samples.at(-1).heapMbAfterGc}MB cpu ${w.cpuPct}% rss ${w.rssMb}MB`);
    }
    if (heapDiff) {
      const end = await heapByConstructor(cdp, rec, saveSnapshot);
      const growth = [...end]
        .map(([k, v]) => [k, v.size - (firstSnapshot.get(k)?.size ?? 0), v.count - (firstSnapshot.get(k)?.count ?? 0)])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);
      for (const [k, size, count] of growth) console.error(`[${build.label}] +${(size / 1024).toFixed(0)}KB +${count} ${k}`);
    }
    const first = samples[0], last = samples.at(-1);
    const minutes = (last.atS - first.atS) / 60 || 1;
    return { build: build.label, samples, heapSlopeMbPerMin: Math.round(((last.heapMbAfterGc - first.heapMbAfterGc) / minutes) * 100) / 100 };
  } finally {
    cdp.close();
  }
}

const SCENARIOS = ["baseline", "A_visible", "B_background", "C_paused"];
const FIELDS = ["cpuPct", "rssMb", "recorderMainThreadPct", "recorderScriptPct", "heapMb", "workletMsgsPerSec", "wsSendsPerSec", "wsBytesPerSec"];

function summarize(runs) {
  const summary = {};
  for (const { label } of builds) {
    const mine = runs.filter((r) => r.build === label);
    summary[label] = {};
    for (const sc of SCENARIOS) {
      summary[label][sc] = {};
      for (const f of FIELDS) summary[label][sc][f] = median(mine.map((r) => r[sc][f]));
      const types = new Set(mine.flatMap((r) => Object.keys(r[sc].cpuByType)));
      summary[label][sc].cpuByType = Object.fromEntries([...types].map((t) => [t, median(mine.map((r) => r[sc].cpuByType[t] ?? 0))]));
      if (sc !== "baseline") summary[label][sc].cpuAboveBaselinePct = Math.round((summary[label][sc].cpuPct - summary[label].baseline.cpuPct) * 10) / 10;
    }
  }
  return summary;
}

function printTable(summary) {
  const labels = Object.keys(summary);
  const rows = [];
  for (const sc of SCENARIOS) {
    for (const f of ["cpuPct", ...(sc === "baseline" ? [] : ["cpuAboveBaselinePct"]), "rssMb", "recorderMainThreadPct", "heapMb", "workletMsgsPerSec", "wsSendsPerSec"]) {
      rows.push([`${sc} ${f}`, ...labels.map((l) => String(summary[l][sc][f]))]);
    }
  }
  const head = ["metric", ...labels];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(line(head));
  for (const r of rows) console.log(line(r));
}

const report = { at: new Date().toISOString(), builds, reps, scenarioMs, baselineMs, warmupMs };
if (soakMs > 0) {
  report.soak = [];
  for (const b of builds) report.soak.push(await soak(b));
  for (const s of report.soak) console.log(`${s.build}: heap slope ${s.heapSlopeMbPerMin} MB/min over ${s.samples.at(-1).atS}s`);
} else {
  const runs = [];
  for (let i = 0; i < reps; i++) {
    const order = i % 2 ? [...builds].reverse() : builds;
    for (const b of order) {
      console.error(`rep ${i + 1}/${reps}: ${b.label}`);
      let r;
      // A run whose tab dies (renderer crash, window closed) is retried once from scratch.
      for (let attempt = 1; !r; attempt++) {
        try {
          r = await runOnce(b);
        } catch (err) {
          if (attempt >= 2) throw err;
          console.error(`retrying ${b.label}: ${err.message}`);
        }
      }
      console.error(JSON.stringify(r));
      runs.push(r);
    }
  }
  report.runs = runs;
  report.summary = summarize(runs);
  printTable(report.summary);
}
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
process.exit(0);
