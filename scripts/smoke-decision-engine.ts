/**
 * The decision chain (src/lib/decisions/engine.ts): Jev, then the account's own chat model
 * where a decision's policy allows it, then the call site's rule — under ONE deadline — and
 * the rule that only a calibrated Jev answer may act on its own.
 *
 * Also the LLM engine itself (decisions/llm.ts) end to end: an account with only a Gemini
 * key, a stubbed Gemini, and the same typed questions Jev answers.
 *
 * Local PGlite, stubbed fetch. Run: npx tsx scripts/smoke-decision-engine.ts
 */
import "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { usageEvents, userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { resolveAiAccess } from "../src/lib/ai-access";
import {
  canAct,
  decide,
  decideEach,
  NO_ENGINES,
  openEngines,
  type Engines,
} from "../src/lib/decisions/engine";
import { choice, noul, parseAnswers, score, type Decider, type DecisionRequest, type QuestionMap } from "../src/lib/decisions/jev";
import { llmReplyToAnswers, openLlmDecider } from "../src/lib/decisions/llm";
import { run } from "./smoke/_env";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
}

/** A decider that answers from a script after `delayMs`; null plays a failed call. */
function scripted(
  answer: (req: DecisionRequest<QuestionMap>) => Record<string, unknown> | null,
  delayMs = 0,
): Decider & { calls: Array<{ op: string; timeoutMs: number }> } {
  const calls: Array<{ op: string; timeoutMs: number }> = [];
  return {
    calls,
    async ask(req, opts) {
      calls.push({ op: req.operation, timeoutMs: opts.timeoutMs });
      if (delayMs) await new Promise((r) => setTimeout(r, Math.min(delayMs, opts.timeoutMs)));
      if (delayMs > opts.timeoutMs) return null;
      const raw = answer(req as DecisionRequest<QuestionMap>);
      const answers = raw ? parseAnswers(req.questions, { answers: raw }) : null;
      return answers ? { answers, model: "scripted" } : null;
    },
  } as Decider & { calls: Array<{ op: string; timeoutMs: number }> };
}

const yes = (p: number) => () => ({ q: { noul: p } });
const request = { operation: "duplicates.same_person" as const, state: { a: 1 }, questions: { q: noul("?") } };

async function chain() {
  console.log("The chain: Jev, then the chat model, then the rule");
  const both = (jev: Decider | null, llm: Decider | null): Engines => ({ jev, llm });
  const policy = { engines: ["jev", "llm"] as const, budgetMs: 2000, jevMs: 500 };

  let r = await decide(both(scripted(yes(0.9)), scripted(yes(0.1))), policy, request);
  check("Jev answers → the LLM is never asked", r.engine === "jev" && r.answers?.q.probability === 0.9);

  const llm = scripted(yes(0.2));
  r = await decide(both(scripted(() => null), llm), policy, request);
  check("Jev gives no answer → the chat model does", r.engine === "llm" && r.answers?.q.probability === 0.2 && llm.calls.length === 1);

  r = await decide(both(scripted(() => null), scripted(() => null)), policy, request);
  check("neither answers → the caller's rule", r.engine === "rules" && r.answers === null);

  r = await decide(NO_ENGINES, policy, request);
  check("no engines at all (no key of any kind) → the rule, with no call made", r.engine === "rules");

  const jevOnlyLlm = scripted(yes(0.3));
  r = await decide(both(null, jevOnlyLlm), { engines: ["jev"], budgetMs: 1000 }, request);
  check("a Jev-only policy never falls to the chat model, even with one available",
    r.engine === "rules" && jevOnlyLlm.calls.length === 0);

  console.log("\nOne deadline for the whole chain");
  const slowJev = scripted(yes(0.9), 400);
  const afterSlow = scripted(yes(0.4));
  const started = Date.now();
  r = await decide(both(slowJev, afterSlow), { engines: ["jev", "llm"], budgetMs: 1000, jevMs: 200 }, request);
  check("a slow Jev is cut at its share of the budget", slowJev.calls[0]?.timeoutMs === 200);
  // The 200 ms cut is a setTimeout, which can land a millisecond early by Date.now() (CI saw
  // 801). decide() reports the clock honestly, so allow jitter — a fresh budget would be 1000.
  check("…and the chat model gets what REMAINS, not a fresh budget",
    r.engine === "llm" && (afterSlow.calls[0]?.timeoutMs ?? 9999) <= 810, afterSlow.calls[0]);
  check("…so the chain ends inside the budget", Date.now() - started < 1000, `${Date.now() - started}ms`);

  const neverStarted = scripted(yes(0.4));
  r = await decide(both(scripted(yes(0.9), 1000), neverStarted), { engines: ["jev", "llm"], budgetMs: 300 }, request);
  check("an engine with no time left is not started", r.engine === "rules" && neverStarted.calls.length === 0);

  console.log("\nOne question per item");
  const items = ["a", "b", "c", "d"];
  const jevHalf = scripted((req) => {
    const keys = Object.keys(req.questions);
    const state = req.state as { items: Record<string, string> };
    return JSON.stringify(state).includes('"c"') ? null : Object.fromEntries(keys.map((k) => [k, { noul: 0.9 }]));
  });
  const llmRest = scripted((req) => Object.fromEntries(Object.keys(req.questions).map((k) => [k, { noul: 0.2 }])));
  const each = await decideEach(both(jevHalf, llmRest), { engines: ["jev", "llm"], budgetMs: 2000 }, {
    operation: "duplicates.same_person",
    items,
    chunkSize: 2,
    concurrency: 2,
    state: (chunk) => ({ items: Object.fromEntries(chunk.map(({ key, item }) => [key, item])) }),
    question: () => noul("?"),
  });
  check("Jev answers what it can; the chat model answers only the rest",
    each.map((e) => e.engine).join(",") === "jev,jev,llm,llm", each.map((e) => e.engine));
  check("…and was asked about just those two", llmRest.calls.length === 1);

  console.log("\nOnly a calibrated Jev answer may act");
  check("Jev at or above an enabled threshold acts", canAct("jev", 0.98, 0.97));
  check("…below it does not", !canAct("jev", 0.96, 0.97));
  check("an LLM answer never acts, however sure it says it is", !canAct("llm", 1, 0.97));
  check("a disabled threshold (null, how every one ships) never acts", !canAct("jev", 1, null));
}

function replies() {
  console.log("\nThe chat model's compact reply, read back through the same validator");
  const qs = { y: noul("?"), p: choice("?", { a: "A", b: "B" }), s: score("?", ["x", "y", "z"]) };
  const ok = parseAnswers(qs, llmReplyToAnswers(qs, { y: 0.7, p: "b", s: 1.6 }));
  check("a yes/no probability, a pick and a level parse", ok?.y.probability === 0.7 && ok.p.choice === "b" && ok.s.score === 2);
  check("a level is rounded to the nearest real one", ok?.s.score === 2);
  check("true/false stand in for 1/0", parseAnswers(qs, llmReplyToAnswers(qs, { y: true, p: "a", s: 0 }))?.y.probability === 1);
  check("a probability past 1 is clamped, not refused", parseAnswers(qs, llmReplyToAnswers(qs, { y: 7, p: "a", s: 0 }))?.y.probability === 1);
  check("an option it made up is no answer", parseAnswers(qs, llmReplyToAnswers(qs, { y: 0.5, p: "zebra", s: 0 })) === null);
  check("a missing key is no answer", parseAnswers(qs, llmReplyToAnswers(qs, { y: 0.5, p: "a" })) === null);
}

const LLM_USER = "smoke-engine-llm";
const NO_KEY_USER = "smoke-engine-none";

async function llmEngine() {
  console.log("\nThe chat model as an engine (an account with only a Gemini key)");
  const db = await getDb();
  for (const u of [LLM_USER, NO_KEY_USER]) {
    await db.delete(usageEvents).where(eq(usageEvents.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
  }
  await db.insert(userSettings).values({ userId: LLM_USER, aiProvider: "gemini", geminiApiKeyEncrypted: encrypt("user-gemini-key") });
  await db.insert(userSettings).values({ userId: NO_KEY_USER });

  const sent: Array<{ url: string; body: { generationConfig?: Record<string, unknown>; contents?: unknown } }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/generativelanguage/.test(url)) {
      sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json({
        candidates: [{ content: { role: "model", parts: [{ text: '{"q": 0.15}' }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 6 },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    const none = await openEngines(NO_KEY_USER, { llm: true });
    check("an account with no key of any kind has no engines", none.jev === null && none.llm === null);

    const engines = await openEngines(LLM_USER, { llm: true });
    check("a Gemini-only account: no Jev, but the chat model is an engine", engines.jev === null && engines.llm !== null);
    check("…and only when the flow asks for it", (await openEngines(LLM_USER)).llm === null);

    const r = await decide(engines, { engines: ["jev", "llm"], budgetMs: 5000 }, request);
    check("it answers the typed question", r.engine === "llm" && r.answers?.q.probability === 0.15, r);
    check("…on the fast tier, not the person's full model", /gemini-3\.1-flash-lite/.test(sent[0]?.url ?? ""), sent[0]?.url);
    const gen = sent[0]?.body.generationConfig ?? {};
    check("…at temperature 0 with a small output cap", gen.temperature === 0 && Number(gen.maxOutputTokens) <= 60, gen);

    const operations = await (async () => {
      for (let i = 0; i < 40; i++) {
        const rows = await db.select({ op: usageEvents.operation }).from(usageEvents).where(eq(usageEvents.userId, LLM_USER));
        if (rows.length) return rows.map((x) => x.op);
        await new Promise((res) => setTimeout(res, 50));
      }
      return [];
    })();
    check("…recorded under its own operation id, never the Jev one", operations.join() === "duplicates.same_person.llm", operations);

    const noLlm = await decide(engines, { engines: ["jev", "llm"], budgetMs: 5000 }, { ...request, operation: "calendar.kind" });
    check("a decision with no LLM operation (calendar) falls straight to the rule", noLlm.engine === "rules");

    const access = await resolveAiAccess(NO_KEY_USER);
    check("openLlmDecider refuses quietly — no throw — for an account that cannot run AI", openLlmDecider(NO_KEY_USER, access) === null);
  } finally {
    globalThis.fetch = realFetch;
    for (const u of [LLM_USER, NO_KEY_USER]) {
      await db.delete(usageEvents).where(eq(usageEvents.userId, u));
      await db.delete(userSettings).where(eq(userSettings.userId, u));
    }
  }
}

run(async () => {
  await chain();
  replies();
  await llmEngine();
  console.log(failures === 0 ? "\nAll decision-engine checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
});
