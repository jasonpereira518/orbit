/**
 * Turn `constellation-interactions.mjs` results into the before/after markdown report.
 *
 *   node scripts/bench/constellation-report.mjs ab.json                  # an --ab run
 *   node scripts/bench/constellation-report.mjs before.json after.json   # two single runs
 *
 * Every number is the median across repetitions; TTI also shows the range, so the noise a
 * change has to clear is on the page next to it.
 *
 * `--min-control 55` (the default) drops any repetition whose empty-page control frame rate was
 * below 55fps, on both sides alike: that run measured a throttled machine, not the chart.
 */
import { readFileSync } from "node:fs";

const files = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--min-control");
const merged = {};
const labels = [];
for (const f of files) {
  const data = JSON.parse(readFileSync(f, "utf8"));
  for (const l of data.labels) {
    merged[l] = data.results[l];
    labels.push(l);
  }
}
const [before, after] = labels;
if (!after) throw new Error("need two labelled result sets (an --ab run, or two files)");

const argv = process.argv.slice(2);
const minControl = argv.includes("--min-control") ? Number(argv[argv.indexOf("--min-control") + 1]) : 55;

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round(((v[m - 1] + v[m]) / 2) * 1000) / 1000;
};
function medianOf(objs) {
  const first = objs[0];
  if (typeof first === "number" || first === null || first === undefined) return median(objs);
  if (typeof first !== "object") return first;
  return Object.fromEntries(Object.keys(first).map((k) => [k, medianOf(objs.map((o) => o?.[k]))]));
}
const dropped = [];
/** Re-derive each size's medians from the runs that pass the control check. */
function summarise(label, r) {
  const kept = r.runs.filter((run) => run.controlFps >= minControl);
  if (kept.length < r.runs.length) dropped.push(`${label} ${r.n}: ${r.runs.length - kept.length}`);
  const m = medianOf(kept.map(({ controlFps, open, gestures }) => ({ controlFps, open, gestures })));
  return { ...r, ...m, reps: kept.length, runs: kept };
}
const byN = (label) =>
  new Map(merged[label].filter((r) => !r.failed).map((r) => [r.n, summarise(label, r)]));
const B = byN(before);
const A = byN(after);
const sizes = [...B.keys()].filter((n) => A.has(n)).sort((a, b) => a - b);

const fmt = (x, digits = 0) => (x === null || x === undefined ? "—" : Number(x).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }));
function change(b, a) {
  if (b === null || a === null || b === undefined || a === undefined) return "—";
  if (b === 0 && a === 0) return "0%";
  if (b === 0) return "new";
  const pct = ((a - b) / b) * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}
const range = (runs, pick) => {
  const v = runs.map(pick).filter((x) => typeof x === "number");
  return v.length ? `${Math.min(...v)}–${Math.max(...v)}` : "—";
};

const SCENARIOS = [
  ["zoom-in", "Zoom in (0.05 → 2.4, 3s)"],
  ["zoom-out", "Zoom out (2.4 → 0.05, 3s)"],
  ["pan-overview", "Pan, overview (circle, 3s)"],
  ["pan-closeup", "Pan, close-up @0.5 (1,800px, 3s)"],
];

const lines = [];
lines.push(`| Scenario | Contacts | Metric | ${before} | ${after} | Change |`);
lines.push("|---|---:|---|---:|---:|---:|");
for (const n of sizes) {
  const b = B.get(n), a = A.get(n);
  lines.push(`| Open | ${fmt(n)} | Time to interactive (ms) | ${fmt(b.open.tti)} | ${fmt(a.open.tti)} | ${change(b.open.tti, a.open.tti)} |`);
  // The same, minus the bench page's own shell boot (identical scaffolding on both sides, and
  // the noisiest stage on a loaded machine).
  const fromFetch = (x) => medianOf(x.runs.map((r) => r.open.tti - r.open.stages.boot));
  lines.push(`| Open | ${fmt(n)} | Data fetch start → interactive (ms) | ${fmt(fromFetch(b))} | ${fmt(fromFetch(a))} | ${change(fromFetch(b), fromFetch(a))} |`);
  lines.push(`| Open | ${fmt(n)} | Long tasks until interactive | ${fmt(b.open.longTasks)} | ${fmt(a.open.longTasks)} | ${change(b.open.longTasks, a.open.longTasks)} |`);
}
for (const [key, name] of SCENARIOS) {
  for (const n of sizes) {
    const b = B.get(n).gestures[key], a = A.get(n).gestures[key];
    lines.push(`| ${name} | ${fmt(n)} | Avg FPS | ${fmt(b.avgFps, 1)} | ${fmt(a.avgFps, 1)} | ${change(b.avgFps, a.avgFps)} |`);
    lines.push(`| ${name} | ${fmt(n)} | Min FPS | ${fmt(b.minFps, 1)} | ${fmt(a.minFps, 1)} | ${change(b.minFps, a.minFps)} |`);
    lines.push(`| ${name} | ${fmt(n)} | Long tasks (>50ms) | ${fmt(b.longTasks)} | ${fmt(a.longTasks)} | ${change(b.longTasks, a.longTasks)} |`);
  }
}

const stages = ["boot", "data", "renderer", "layout", "paint", "settle"];
const st = [];
st.push(`| Contacts | TTI ${before} (range) | TTI ${after} (range) | ${stages.map((s) => `${s} ms`).join(" | ")} |`);
st.push(`|---:|---:|---:|${stages.map(() => "---:").join("|")}|`);
for (const n of sizes) {
  const b = B.get(n), a = A.get(n);
  st.push(
    `| ${fmt(n)} | ${fmt(b.open.tti)} (${range(b.runs, (r) => r.open.tti)}) | ${fmt(a.open.tti)} (${range(a.runs, (r) => r.open.tti)}) | ` +
      stages.map((s) => `${fmt(b.open.stages[s])} → ${fmt(a.open.stages[s])}`).join(" | ") +
      " |"
  );
}

const ctl = sizes.map((n) => `${fmt(n)}: ${B.get(n).controlFps} / ${A.get(n).controlFps}`).join(", ");
const reps = sizes.map((n) => `${fmt(n)}: ${B.get(n).reps}/${A.get(n).reps}`).join(", ");
const homes = sizes.map((n) => `${fmt(n)}: ${B.get(n).open.homeZoom} / ${A.get(n).open.homeZoom}`).join(", ");

console.log(lines.join("\n"));
console.log("\n**Open, by stage** (median ms; `constellation:*` marks)\n");
console.log(st.join("\n"));
console.log(`\nMedians over the repetitions kept per size (${before}/${after}) — ${reps}. Dropped for a control frame rate under ${minControl}fps: ${dropped.length ? dropped.join(", ") : "none"}. Median control FPS on an empty page (${before} / ${after}): ${ctl}.`);
console.log(`Opening zoom (${before} / ${after}) — the framing must not change: ${homes}.`);
