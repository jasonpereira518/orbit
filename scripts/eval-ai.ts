/**
 * The accuracy gate for AI cost work: runs Orbit's real AI features over synthetic fixtures,
 * scores them, and records what each case cost — so "make it cheaper" can be checked against
 * "and it still works" before it ships.
 *
 *   ORBIT_EVAL_GEMINI_KEY=… npx tsx scripts/eval-ai.ts --provider gemini
 *   ORBIT_EVAL_ANTHROPIC_KEY=… ORBIT_EVAL_OPENAI_KEY=… npx tsx scripts/eval-ai.ts \
 *     --provider anthropic --model claude-sonnet-5 --runs 2 \
 *     --compare docs/ai-evals/2026-09-19-anthropic-claude-sonnet-4-5.json
 *
 * Flags: --provider gemini|openai|anthropic (default gemini) · --model <id> (default: the
 * provider's default model) · --task capture,recruiter,extension,ocr,transcribe,chat,digest
 * (default all) · --runs N (default 1; use 2+ for a gate decision — models are not
 * deterministic) · --limit N (cases per task, for a quick look) · --label <name> ·
 * --out <file> (default docs/ai-evals/<date>-<label>.json) · --compare <baseline.json>
 * (exits 1 when a threshold in scripts/eval-fixtures/ai-eval-thresholds.json is broken).
 *
 * KEYS. Only `ORBIT_EVAL_{GEMINI,OPENAI,ANTHROPIC,WISPR}_KEY` are used, stored as the
 * synthetic user's OWN keys — the same bring-your-own-key path a person's pasted key takes
 * through the AI gate, so every model is reachable (Orbit's managed keys would pin the model
 * to the managed allowlist). The ordinary `GEMINI_API_KEY`-style names are deliberately
 * ignored and stripped: a developer's `.env.local` key must never be spent by just running a
 * script. A full run costs roughly a dollar or two per provider.
 *
 * SAFETY. `./smoke/_env` removes `DATABASE_URL` (never the shared Neon database) and points
 * PGlite at a throwaway directory, so this never contends with a dev server.
 */
import "./smoke/_env";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { usageEvents, userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { DEFAULT_MODELS, resolveAiProvider, type AiProvider } from "../src/lib/ai-providers";
import { FIXTURE_DIR, TASKS, TASK_NAMES, type TaskName, type TaskResult } from "./lib/eval-ai-tasks";
import { gate, median, type GateRules, type TaskMetrics } from "./lib/eval-ai-score";

const USER = "eval-ai-user";

if (process.env.DATABASE_URL) {
  throw new Error("eval-ai runs on a throwaway local PGlite only — unset DATABASE_URL (and SMOKE_ALLOW_REMOTE).");
}
// The synthetic user must not count as a localhost demo account riding managed keys.
process.env.ORBIT_DEMO_MANAGED_AI = "off";
// Measure the model, not the answer cache: run 2 of a case must call the model again.
process.env.ORBIT_AI_RESULT_CACHE = "off";

type Args = {
  provider: AiProvider;
  model: string;
  tasks: TaskName[];
  runs: number;
  limit?: number;
  label: string;
  out: string;
  compare?: string;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const provider = resolveAiProvider(get("--provider") ?? "gemini");
  const model = get("--model") ?? DEFAULT_MODELS[provider];
  const taskArg = get("--task");
  const tasks = (!taskArg || taskArg === "all" ? TASK_NAMES : taskArg.split(",")) as TaskName[];
  for (const t of tasks) {
    if (!TASK_NAMES.includes(t)) throw new Error(`Unknown task "${t}". Tasks: ${TASK_NAMES.join(", ")}`);
  }
  const label = get("--label") ?? `${provider}-${model}`;
  const date = new Date().toISOString().slice(0, 10);
  return {
    provider,
    model,
    tasks,
    runs: Math.max(1, Number(get("--runs") ?? 1)),
    limit: get("--limit") ? Number(get("--limit")) : undefined,
    label,
    out: get("--out") ?? join("docs", "ai-evals", `${date}-${label.replace(/[^\w.-]+/g, "_")}.json`),
    compare: get("--compare"),
  };
}

/** The eval's keys, by provider — only the `ORBIT_EVAL_*` names (see the header). */
function evalKeys() {
  const read = (name: string) => process.env[name]?.trim() || null;
  return {
    gemini: read("ORBIT_EVAL_GEMINI_KEY"),
    openai: read("ORBIT_EVAL_OPENAI_KEY"),
    anthropic: read("ORBIT_EVAL_ANTHROPIC_KEY"),
    wispr: read("ORBIT_EVAL_WISPR_KEY"),
  };
}

async function setUpUser(args: Args, keys: ReturnType<typeof evalKeys>) {
  const db = await getDb();
  const values = {
    aiProvider: args.provider,
    aiModel: args.model,
    geminiApiKeyEncrypted: keys.gemini ? encrypt(keys.gemini) : null,
    openaiApiKeyEncrypted: keys.openai ? encrypt(keys.openai) : null,
    anthropicApiKeyEncrypted: keys.anthropic ? encrypt(keys.anthropic) : null,
    wisprApiKeyEncrypted: keys.wispr ? encrypt(keys.wispr) : null,
  };
  await db
    .insert(userSettings)
    .values({ userId: USER, ...values })
    .onConflictDoUpdate({ target: userSettings.userId, set: values });
}

type CostRow = { operation: string; model: string; calls: number; failures: number; costMicros: number; unpriced: number };

async function usageSince(since: Date): Promise<CostRow[]> {
  // Usage rows are written fire-and-forget; let the last ones land.
  await new Promise((r) => setTimeout(r, 600));
  const db = await getDb();
  const rows = await db
    .select({
      operation: usageEvents.operation,
      model: usageEvents.model,
      calls: sql<number>`count(*)::int`,
      failures: sql<number>`(count(*) filter (where ${usageEvents.success} = 0))::int`,
      costMicros: sql<number>`coalesce(sum(${usageEvents.estimatedCostMicros}), 0)::float8`,
      unpriced: sql<number>`(count(*) filter (where ${usageEvents.estimatedCostMicros} is null and ${usageEvents.success} = 1))::int`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, USER), gte(usageEvents.createdAt, since)))
    .groupBy(usageEvents.operation, usageEvents.model);
  return rows.map((r) => ({
    operation: r.operation,
    model: r.model,
    calls: Number(r.calls),
    failures: Number(r.failures),
    costMicros: Number(r.costMicros),
    unpriced: Number(r.unpriced),
  }));
}

function averageMetrics(runs: TaskMetrics[]): TaskMetrics {
  const out: TaskMetrics = {};
  for (const key of Object.keys(runs[0] ?? {})) {
    const values = runs.map((r) => r[key]).filter((v): v is number => v != null);
    out[key] = values.length ? values.reduce((n, v) => n + v, 0) / values.length : null;
  }
  return out;
}

function fixtureDigest(): string {
  const hash = createHash("sha256");
  for (const file of [
    "ai-capture-eval.json", "ai-recruiter-eval.json", "ai-extension-eval.json", "ai-ocr-eval.json",
    "ai-transcribe-eval.json", "ai-chat-eval.json", "ai-digest-eval.json", "contact-search-eval.json",
  ]) {
    try {
      hash.update(readFileSync(join(FIXTURE_DIR, file)));
    } catch {
      hash.update(`missing:${file}`);
    }
  }
  return hash.digest("hex").slice(0, 12);
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;

export type EvalReport = {
  label: string;
  provider: AiProvider;
  model: string;
  date: string;
  commit: string | null;
  fixtures: string;
  runs: number;
  tasks: Partial<
    Record<
      TaskName,
      {
        cases: number;
        metrics: TaskMetrics;
        misses: string[];
        p50LatencyMs: number | null;
        costMicros: number;
        costPerCaseMicros: number | null;
        usage: CostRow[];
      }
    >
  >;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keys = evalKeys();
  if (!keys[args.provider]) {
    throw new Error(`Set ORBIT_EVAL_${args.provider.toUpperCase()}_KEY to evaluate ${args.provider}.`);
  }
  await setUpUser(args, keys);

  console.log(`eval-ai: ${args.label} — ${args.provider} / ${args.model}, ${args.runs} run(s), tasks: ${args.tasks.join(", ")}`);
  const report: EvalReport = {
    label: args.label,
    provider: args.provider,
    model: args.model,
    date: new Date().toISOString(),
    commit: gitCommit(),
    fixtures: fixtureDigest(),
    runs: args.runs,
    tasks: {},
  };

  for (const task of args.tasks) {
    console.log(`\n${task}`);
    const perRun: TaskResult[] = [];
    const started = new Date();
    for (let run = 0; run < args.runs; run++) {
      if (args.runs > 1) console.log(` run ${run + 1}/${args.runs}`);
      // Chat seeds a network; a second run must not seed it twice.
      if (task === "chat" && run > 0) {
        const db = await getDb();
        await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
        await db.execute(sql`DELETE FROM tags WHERE user_id = ${USER}`);
      }
      perRun.push(await TASKS[task]({ userId: USER, limit: args.limit, log: (l) => console.log(l) }));
    }
    const usage = await usageSince(started);
    const costMicros = usage.reduce((n, r) => n + r.costMicros, 0) / args.runs;
    const cases = perRun[0]?.cases ?? 0;
    report.tasks[task] = {
      cases,
      metrics: averageMetrics(perRun.map((r) => r.metrics)),
      misses: [...new Set(perRun.flatMap((r) => r.misses))],
      p50LatencyMs: median(perRun.flatMap((r) => r.latenciesMs)),
      costMicros,
      costPerCaseMicros: cases ? costMicros / cases : null,
      usage,
    };
  }

  console.log("\nSummary");
  for (const [task, t] of Object.entries(report.tasks)) {
    const metrics = Object.entries(t.metrics)
      .map(([k, v]) => `${k} ${v == null ? "—" : k.endsWith("Hits") || k.startsWith("phantom") ? v.toFixed(1) : pct(v)}`)
      .join(" · ");
    console.log(`  ${task.padEnd(11)} ${metrics}`);
    console.log(
      `  ${"".padEnd(11)} ${t.cases} case(s) · ${usd(t.costMicros)} total · ${t.costPerCaseMicros == null ? "—" : usd(t.costPerCaseMicros)}/case · p50 ${t.p50LatencyMs == null ? "—" : `${Math.round(t.p50LatencyMs)}ms`}${t.usage.some((u) => u.unpriced) ? " · some calls unpriced" : ""}`
    );
  }

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${args.out}`);

  if (args.compare) {
    const baseline = JSON.parse(readFileSync(args.compare, "utf8")) as EvalReport;
    const rules = JSON.parse(readFileSync(join("scripts", "eval-fixtures", "ai-eval-thresholds.json"), "utf8")) as GateRules & {
      $comment?: string;
    };
    delete rules.$comment;
    if (baseline.fixtures !== report.fixtures) {
      console.warn(`\nWARNING: the fixtures changed since the baseline (${baseline.fixtures} → ${report.fixtures}); re-run the baseline before trusting this comparison.`);
    }
    const pick = (r: EvalReport) =>
      Object.fromEntries(Object.entries(r.tasks).map(([k, v]) => [k, v.metrics])) as Record<string, TaskMetrics>;
    const findings = gate(rules, pick(baseline), pick(report));

    console.log(`\nCompared with ${baseline.label} (${baseline.model}):`);
    for (const [task, t] of Object.entries(report.tasks)) {
      const b = baseline.tasks[task as TaskName];
      if (!b) continue;
      const delta = b.costPerCaseMicros && t.costPerCaseMicros != null ? t.costPerCaseMicros / b.costPerCaseMicros - 1 : null;
      console.log(
        `  ${task.padEnd(11)} cost/case ${b.costPerCaseMicros == null ? "—" : usd(b.costPerCaseMicros)} → ${t.costPerCaseMicros == null ? "—" : usd(t.costPerCaseMicros)}${delta == null ? "" : ` (${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(0)}%)`}`
      );
    }
    if (findings.length === 0) {
      console.log("\nGATE: PASS — no threshold broken.");
    } else {
      console.log("\nGATE: FAIL");
      for (const f of findings) {
        console.log(`  ${f.task}.${f.metric}: ${f.baseline.toFixed(3)} → ${f.candidate.toFixed(3)} (allowed ${f.allowed})`);
      }
      process.exit(1);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
