/**
 * Phase 0 of the Jev plan: the four things TypeSafe's docs do not pin down, measured on a
 * real key before any threshold is trusted. Re-run it whenever `JEV_MODEL` moves.
 *
 *   1. SHAPE        — do real answers parse (`noul`, `choice`, `score`, confidence)?
 *   2. BILLING      — does a call with N questions over one state bill the state once, or
 *                     N times? This decides the rerank's chunk size, and whether Jev beats
 *                     flash-lite there at all.
 *   3. LATENCY      — p50 / p95 from here, for 1, 13 and 60 questions.
 *   4. DETERMINISM  — do identical calls give identical answers? Rankings must not reshuffle.
 *
 * Goes through the production decider on a throwaway PGlite account — the source guard keeps
 * raw TypeSafe calls inside the gate, and the usage ledger is where token counts land anyway.
 *
 *   ORBIT_EVAL_TYPESAFE_KEY=… npx tsx scripts/spike-jev.ts [--out docs/ai-evals/<date>-jev-spike.json]
 *
 * Costs well under a cent.
 */
import "./smoke/_env";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { usageEvents, userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { JEV_MODEL } from "../src/lib/ai-models";
import { resolveAiAccess, typesafeClient } from "../src/lib/ai-access";
import { looksLikeApiKey } from "../src/lib/ai-key-check";
import { classifyAiError } from "../src/lib/errors";
import { choice, noul, openDecider, parseAnswers, score, type Decider, type QuestionMap } from "../src/lib/decisions/jev";
import { RERANK_LEVELS } from "../src/lib/decisions/catalog";
import { run } from "./smoke/_env";

const USER = "jev-spike-user";
process.env.ORBIT_AI_RESULT_CACHE = "off";
process.env.ORBIT_DEMO_MANAGED_AI = "off";

const out = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : join("docs", "ai-evals", `${new Date().toISOString().slice(0, 10)}-jev-spike.json`);
})();

/** Sixty plausible contact cards — the size and shape of a real rerank state. */
const COMPANIES = ["Stripe", "Ramp", "Plaid", "Notion", "Figma", "Datadog", "Snowflake", "Brex", "Rippling", "Vercel"];
const TITLES = ["Staff Engineer", "Product Manager", "Recruiter", "Designer", "Founder", "Data Scientist"];
const cards = Array.from({ length: 60 }, (_, i) => ({
  name: `Contact ${i + 1}`,
  title: TITLES[i % TITLES.length],
  company: COMPANIES[i % COMPANIES.length],
  school: i % 4 === 0 ? "UNC Chapel Hill" : null,
  tags: i % 3 === 0 ? ["payments"] : null,
  summary: `Met at a ${i % 2 ? "meetup" : "conference"}; works on ${i % 3 === 0 ? "payments infrastructure" : "developer tools"}.`,
}));
const key = (i: number) => `c${String(i + 1).padStart(2, "0")}`;
const rerankState = (n: number) => ({
  question: "who do I know that works on payments?",
  candidates: Object.fromEntries(cards.slice(0, n).map((c, i) => [key(i), c])),
});
const rerankQuestions = (n: number): QuestionMap =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      key(i),
      score(`How well does the contact in \`candidates.${key(i)}\` match what \`question\` asks for?`, RERANK_LEVELS),
    ])
  );

async function lastUsage(): Promise<number | null> {
  await new Promise((r) => setTimeout(r, 150));
  const db = await getDb();
  const rows = await db
    .select({ input: usageEvents.inputTokens })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, USER), eq(usageEvents.success, 1)))
    .orderBy(asc(usageEvents.createdAt));
  return rows.at(-1)?.input ?? null;
}

/**
 * One question set. A call that gets no answer ENDS the spike: every later number would be
 * the timing of a failure (a first run with a bad key reported 1ms "latencies" that way).
 */
async function timedAsk(decider: Decider, state: Record<string, unknown>, questions: QuestionMap) {
  const started = performance.now();
  const result = await decider.ask({ operation: "chat.rerank.decide", state, questions }, { timeoutMs: 15_000 });
  const ms = performance.now() - started;
  if (!result) {
    const db = await getDb();
    const [last] = await db
      .select({ ok: usageEvents.success, kind: usageEvents.errorKind })
      .from(usageEvents)
      .where(eq(usageEvents.userId, USER))
      .orderBy(desc(usageEvents.createdAt))
      .limit(1);
    throw new Error(
      last && !last.ok
        ? `a TypeSafe call failed (${last.kind ?? "unknown"}) — ${last.kind === "auth" ? "the key was refused" : "see the kind above"}; stopping rather than timing failures`
        : "an answer came back but did not parse — run again and read the raw shape printed in step 1"
    );
  }
  return { result, ms };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null;
};

run(async () => {
  const apiKey = process.env.ORBIT_EVAL_TYPESAFE_KEY?.trim();
  if (!apiKey) throw new Error("Set ORBIT_EVAL_TYPESAFE_KEY to run the spike.");
  if (!looksLikeApiKey(apiKey)) {
    throw new Error("ORBIT_EVAL_TYPESAFE_KEY is not a key (a placeholder like `…`, or a stray character from a paste). Copy it again from console.typesafe.ai/keys.");
  }
  const db = await getDb();
  await db.delete(usageEvents).where(eq(usageEvents.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({ userId: USER, typesafeApiKeyEncrypted: encrypt(apiKey) });
  const decider = await openDecider(USER);
  if (!decider) throw new Error("No decider — the key did not reach the account row.");

  console.log(`spike-jev: ${JEV_MODEL}\n\n1. Shape`);
  // The raw response, through the gate's own client, so a shape mismatch shows what TypeSafe
  // actually sent instead of just "no answer".
  const shapeQuestions = {
    yes: noul("Is the sender of `text` a recruiter?"),
    pick: choice("What is `text` mainly about?", { hiring: "A job or hiring", sales: "Selling a product", other: "Anything else" }),
    rank: score("How specific is the role described in `text`?", ["No role", "A vague role", "A named role", "A named role with details"]),
  };
  const grant = (await resolveAiAccess(USER)).decision("chat.rerank.decide")!;
  let raw;
  try {
    raw = await typesafeClient(grant).systemOne({
      model: JEV_MODEL,
      state: { text: "Hi — I'm a recruiter at Acme with a staff backend role you'd fit." },
      questions: shapeQuestions as never,
    });
  } catch (err) {
    throw new Error(`TypeSafe refused the first call (${classifyAiError(err)}): ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`  raw: ${JSON.stringify(raw)}`);
  const parsed = parseAnswers(shapeQuestions, raw);
  console.log(parsed ? `  parsed: ${JSON.stringify(parsed)}` : "  DID NOT PARSE — the raw shape above differs from what decisions/jev.ts expects");
  if (!parsed) throw new Error("fix the parser against the raw shape before measuring anything else");
  const shape = { result: { answers: parsed, model: typeof raw.model === "string" ? raw.model : JEV_MODEL } };

  console.log("\n2. Billing — one state, more questions");
  const billing: Array<{ questions: number; inputTokens: number | null }> = [];
  for (const n of [1, 13, 60]) {
    await timedAsk(decider, rerankState(60), rerankQuestions(n));
    billing.push({ questions: n, inputTokens: await lastUsage() });
    console.log(`  ${n} question(s) over 60 cards: ${billing.at(-1)!.inputTokens ?? "?"} input tokens`);
  }
  const [one, , sixty] = billing;
  const perQuestion = one.inputTokens && sixty.inputTokens ? sixty.inputTokens / one.inputTokens : null;
  console.log(perQuestion == null ? "  (no usage reported)" : `  60 questions bill ${perQuestion.toFixed(1)}× one question — ${perQuestion < 3 ? "the state is billed about once" : "the state is billed per question: keep chunks small"}`);

  console.log("\n3. Latency (10 calls each)");
  const latency: Record<string, { p50: number | null; p95: number | null }> = {};
  for (const n of [1, 13, 60]) {
    const ms: number[] = [];
    for (let i = 0; i < 10; i++) ms.push((await timedAsk(decider, rerankState(Math.max(n, 15)), rerankQuestions(n))).ms);
    latency[String(n)] = { p50: pct(ms, 50), p95: pct(ms, 95) };
    console.log(`  ${n} question(s): p50 ${Math.round(latency[String(n)].p50 ?? 0)}ms · p95 ${Math.round(latency[String(n)].p95 ?? 0)}ms`);
  }

  console.log("\n4. Determinism (the same 13-question call, 3 times)");
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push((await timedAsk(decider, rerankState(15), rerankQuestions(13))).result);
  const scores = runs.map((r) => (r ? Object.values(r.answers).map((a) => (a as { score: number }).score) : null));
  let maxDrift = 0;
  if (scores.every(Boolean)) {
    for (let q = 0; q < scores[0]!.length; q++) {
      const vals = scores.map((s) => s![q]);
      maxDrift = Math.max(maxDrift, Math.max(...vals) - Math.min(...vals));
    }
  }
  console.log(scores.every(Boolean) ? `  largest score drift across runs: ${maxDrift.toFixed(3)} levels` : "  a run returned no answer");

  const report = {
    model: JEV_MODEL,
    date: new Date().toISOString(),
    shapeParsed: Boolean(shape.result),
    shapeSample: shape.result?.answers ?? null,
    billing,
    billingRatio60to1: perQuestion,
    latencyMs: latency,
    determinismMaxDrift: scores.every(Boolean) ? maxDrift : null,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${out}`);
  await db.delete(usageEvents).where(eq(usageEvents.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
});
