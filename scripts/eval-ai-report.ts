/**
 * Reads the per-task reports `scripts/eval-ai.ts` writes and prints one table: accuracy and
 * cost per case, baseline against candidate, with the gate's verdict.
 *
 * Tasks are run as separate processes (one per task, in parallel, each with its own
 * throwaway database), so a run is a DIRECTORY of reports rather than one file.
 *
 *   npx tsx scripts/eval-ai-report.ts <baseline-dir> [candidate-dir]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gate, type GateRules, type TaskMetrics } from "./lib/eval-ai-score";

type Report = {
  label: string;
  model: string;
  tasks: Record<string, { cases: number; metrics: TaskMetrics; costMicros: number; costPerCaseMicros: number | null; misses: string[] }>;
};

function load(dir: string): Report["tasks"] {
  const tasks: Report["tasks"] = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const report = JSON.parse(readFileSync(join(dir, file), "utf8")) as Report;
    Object.assign(tasks, report.tasks);
  }
  return tasks;
}

const usd = (micros: number | null) => (micros == null ? "—" : `$${(micros / 1_000_000).toFixed(4)}`);
const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(0)}%`);
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

function main() {
  const [baseDir, candDir] = process.argv.slice(2);
  if (!baseDir) {
    console.error("usage: npx tsx scripts/eval-ai-report.ts <baseline-dir> [candidate-dir]");
    process.exit(2);
  }
  const base = load(baseDir);
  const cand = candDir ? load(candDir) : null;

  let baseTotal = 0;
  let candTotal = 0;
  console.log(`\n${pad("task", 11)}${pad("cases", 7)}${pad("cost/case", 12)}${cand ? pad("candidate", 12) + pad("change", 9) : ""}accuracy`);
  for (const [task, b] of Object.entries(base)) {
    const c = cand?.[task];
    baseTotal += b.costMicros;
    if (c) candTotal += c.costMicros;
    const delta =
      c?.costPerCaseMicros != null && b.costPerCaseMicros
        ? `${c.costPerCaseMicros / b.costPerCaseMicros - 1 >= 0 ? "+" : ""}${(((c.costPerCaseMicros / b.costPerCaseMicros) - 1) * 100).toFixed(0)}%`
        : "—";
    const metrics = Object.entries((c ?? b).metrics)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k} ${k.endsWith("Hits") || k.startsWith("phantom") ? v : pct(v as number)}`)
      .join(" · ");
    console.log(
      `${pad(task, 11)}${pad(String(b.cases), 7)}${pad(usd(b.costPerCaseMicros), 12)}${cand ? pad(usd(c?.costPerCaseMicros ?? null), 12) + pad(delta, 9) : ""}${metrics}`
    );
  }
  console.log(
    `\ntotal for one pass over the fixtures: ${usd(baseTotal)}${cand ? ` → ${usd(candTotal)} (${candTotal < baseTotal ? "-" : "+"}${Math.abs(((candTotal / baseTotal) - 1) * 100).toFixed(0)}%)` : ""}`
  );

  if (!cand) return;
  const rules = JSON.parse(readFileSync(join("scripts", "eval-fixtures", "ai-eval-thresholds.json"), "utf8")) as GateRules & { $comment?: string };
  delete rules.$comment;
  const metricsOf = (tasks: Report["tasks"]) =>
    Object.fromEntries(Object.entries(tasks).map(([k, v]) => [k, v.metrics])) as Record<string, TaskMetrics>;
  const findings = gate(rules, metricsOf(base), metricsOf(cand));
  if (findings.length === 0) {
    console.log("\nGATE: PASS — nothing the thresholds care about got worse.");
  } else {
    console.log("\nGATE: FAIL");
    for (const f of findings) {
      console.log(`  ${f.task}.${f.metric}: ${f.baseline.toFixed(3)} → ${f.candidate.toFixed(3)} (allowed ${f.allowed})`);
    }
  }
}

main();
