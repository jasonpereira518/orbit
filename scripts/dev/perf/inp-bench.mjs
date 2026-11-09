/**
 * Interaction responsiveness (INP-style), on a 4x-CPU-throttled desktop viewport: scripted
 * keystrokes and clicks while a PerformanceObserver collects Event Timing entries
 * (`durationThreshold: 16`). Reports, per scenario, the worst and median event duration and
 * the slowest event's phases (input delay / processing / presentation delay).
 *
 *   node scripts/dev/perf/inp-bench.mjs <baseUrl> [--rounds=n] [--cpu=4] [--json=out]
 */
import { writeFileSync } from "node:fs";
import { launch } from "../cdp.mjs";

const args = process.argv.slice(2);
const BASE = args.find((a) => !a.startsWith("--")) ?? "http://localhost:4100";
const flag = (n, d) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const ROUNDS = Number(flag("rounds", 3));
const CPU = Number(flag("cpu", 4));
const JSON_OUT = flag("json", null);

const OBS = `window.__ev = []; new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__ev.push({ n: e.name, d: e.duration, id: e.processingStart - e.startTime, p: e.processingEnd - e.processingStart, pr: e.startTime + e.duration - e.processingEnd }))).observe({ type: "event", durationThreshold: 16, buffered: false });`;
const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };

const SCENARIOS = [
  { name: "contacts: type 6 chars in search", url: "/contacts", run: async (c) => {
    await c.evaluate(`document.querySelector('input[placeholder*="earch contacts" i]').focus()`);
    for (const ch of "sarah ") { await c.type(ch); await c.sleep(60); }
    await c.sleep(1500);
  } },
  { name: "contacts: open Sort menu and close", url: "/contacts", run: async (c) => {
    await c.clickText("button", "Sort"); await c.sleep(500); await c.key("Escape"); await c.sleep(500);
  } },
  { name: "contacts: open Company filter", url: "/contacts", run: async (c) => {
    await c.clickText("button", "Company"); await c.sleep(600); await c.key("Escape"); await c.sleep(400);
  } },
  { name: "shell: ⌘K palette open + type", url: "/dashboard", run: async (c) => {
    await c.key("k", { modifiers: 4 }); await c.sleep(800);
    for (const ch of "sar") { await c.type(ch); await c.sleep(60); }
    await c.sleep(1200); await c.key("Escape"); await c.sleep(300);
  } },
  { name: "dashboard: click first card button", url: "/dashboard", run: async (c) => {
    await c.clickText("main button", "Follow up"); await c.sleep(1200); await c.key("Escape"); await c.sleep(400);
  } },
  { name: "chat: type in composer", url: "/chat", run: async (c) => {
    await c.evaluate(`(document.querySelector('textarea') || document.querySelector('[contenteditable]')).focus()`);
    for (const ch of "who should I follow up with") { await c.type(ch); await c.sleep(30); }
    await c.sleep(800);
  } },
];

const out = { base: BASE, cpu: CPU, scenarios: {} };
for (const s of SCENARIOS) {
  const worst = [], med = [], detail = [];
  for (let r = 0; r < ROUNDS; r++) {
    const c = await launch({ width: 1440, height: 900 });
    try {
      await c.send("Page.addScriptToEvaluateOnNewDocument", { source: OBS });
      await c.goto(`${BASE}${s.url}`);
      await c.waitHydrated();
      await c.sleep(2500);
      await c.send("Emulation.setCPUThrottlingRate", { rate: CPU });
      await c.evaluate(`window.__ev.length = 0`);
      await s.run(c);
      const ev = JSON.parse(await c.evaluate(`JSON.stringify(window.__ev)`));
      const ds = ev.map((e) => e.d);
      worst.push(ds.length ? Math.max(...ds) : 0);
      med.push(median(ds) ?? 0);
      const w = ev.sort((a, b) => b.d - a.d)[0];
      if (w) detail.push(w);
    } catch (e) {
      console.error(s.name, "failed:", e.message);
    } finally { c.close(); }
  }
  const w = detail.sort((a, b) => b.d - a.d)[Math.floor(detail.length / 2)];
  out.scenarios[s.name] = { worstMs: median(worst), medianMs: median(med), slowest: w && { name: w.n, duration: w.d, inputDelay: w.id, processing: w.p, presentation: w.pr } };
  console.log(`${s.name.padEnd(36)} worst ${String(median(worst)).padStart(4)} ms  median ${String(median(med)).padStart(4)} ms` + (w ? `   [${w.n}: delay ${w.id.toFixed(0)} / proc ${w.p.toFixed(0)} / paint ${w.pr.toFixed(0)}]` : ""));
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
