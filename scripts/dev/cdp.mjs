/**
 * Zero-dependency headless-Chrome driver over CDP, for verifying UI the in-app Browser
 * pane cannot: it runs `document.visibilityState === "visible"`, so rAF, motion/react
 * transitions, AnimatePresence swaps and CSS transitions all advance for real, and it
 * accepts a mobile viewport, reduced-motion emulation, file uploads and synthetic drags.
 *
 * Node 22+ (global WebSocket), no npm install. Not part of the smoke suite.
 *
 *   node scripts/dev/cdp.mjs http://localhost:3001/capture my-scenario.mjs
 *
 * where `my-scenario.mjs` exports `run(cdp)`, or import `launch()` from a script of your
 * own. Wait for hydration (`cdp.waitHydrated()`) before clicking anything — a click that
 * lands before React attaches hits the SSR markup and does nothing.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function launch({ width = 1280, height = 800, mobile = false, reduceMotion = false } = {}) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "orbit-cdp-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    `--window-size=${width},${height}`,
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "about:blank",
  ];
  const proc = spawn(CHROME, args, { stdio: "ignore" });
  const started = Date.now();
  let targets = null;
  while (Date.now() - started < 15000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await res.json();
      if (targets.length) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!targets) throw new Error("Chrome did not start");
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const l of listeners.get(msg.method)) l(msg.params);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const on = (method, fn) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
  if (reduceMotion) await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const consoleErrors = [];
  on("Runtime.exceptionThrown", (p) => consoleErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
  on("Runtime.consoleAPICalled", (p) => { if (p.type === "error") consoleErrors.push(p.args.map((a) => a.value ?? a.description).join(" ")); });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.value;
  };
  const goto = async (url) => {
    const loaded = new Promise((r) => on("Page.loadEventFired", r));
    await send("Page.navigate", { url });
    await loaded;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (expr, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await evaluate(expr)) return true;
      await sleep(150);
    }
    throw new Error(`timeout waiting for ${expr}`);
  };
  const screenshot = async (path) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(r.data, "base64"));
    return path;
  };
  const clickText = async (selector, text) => {
    const rect = await evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = els.find(e => e.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
    if (!rect) throw new Error(`no element ${selector} with text ${text}`);
    await sleep(80);
    await click(rect.x, rect.y);
  };
  const clickSel = async (selector) => {
    const rect = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
    if (!rect) throw new Error(`no element ${selector}`);
    await sleep(80);
    await click(rect.x, rect.y);
  };
  const click = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const drag = async (x1, y1, x2, y2, steps = 12, stepMs = 16) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = x1 + ((x2 - x1) * i) / steps, y = y1 + ((y2 - y1) * i) / steps;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      await sleep(stepMs);
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", clickCount: 1 });
  };
  const key = async (k, opts = {}) => {
    const map = { ArrowRight: 39, ArrowLeft: 37, ArrowDown: 40, Backspace: 8, Enter: 13, Tab: 9, Escape: 27 };
    const base = { key: k, code: k, windowsVirtualKeyCode: map[k] ?? k.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: map[k] ?? k.toUpperCase().charCodeAt(0), ...opts };
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };
  const type = async (text) => { await send("Input.insertText", { text }); };
  /** Wait until React has attached to the page (a fiber key on the main element). */
  const waitHydrated = () => waitFor(`(() => { const el = document.querySelector('main') ?? document.body; return Object.keys(el).some(k => k.startsWith('__reactFiber')) })()`, 20000);
  const setFiles = async (selector, paths) => {
    const doc = await send("DOM.getDocument", { depth: 1 });
    const q = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    if (!q.nodeId) throw new Error(`no node for ${selector}`);
    await send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: paths });
  };
  const close = () => { try { ws.close(); } catch {} proc.kill(); };
  return { send, evaluate, goto, sleep, waitFor, waitHydrated, screenshot, click, clickSel, clickText, drag, key, type, setFiles, close, consoleErrors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [url, scriptPath] = process.argv.slice(2);
  const cdp = await launch();
  try {
    await cdp.goto(url);
    const mod = await import(join(process.cwd(), scriptPath));
    await mod.run(cdp);
  } finally {
    cdp.close();
  }
}
