/**
 * The skip-gates (src/lib/decisions/gates.ts): what each one does with a confident no, an
 * unsure answer, a decider that gives nothing, and no decider at all.
 *
 * The rule the whole phase rests on: a gate may only ever SKIP a call, and only on a
 * confident Jev "no". Without a decision model every gated step runs exactly as it always
 * has — so the "no engines" cases here are the ones that matter most.
 *
 * No DB, no network: scripted deciders.
 *
 * Run: npx tsx scripts/smoke-decisions-gates.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gateProbability, gateSkips, gateText } from "../src/lib/decisions/gates";
import { SKIP_GATES, SKIP_GATE_TUNING } from "../src/lib/decisions/catalog";
import { NO_ENGINES, type Engines } from "../src/lib/decisions/engine";
import { parseAnswers, type Decider, type DecisionRequest, type QuestionMap } from "../src/lib/decisions/jev";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

/** A decider that answers every question with `p`, or gives no answer when `p` is null. */
function scripted(p: number | null): Engines & { asked: number; last: DecisionRequest<QuestionMap> | null } {
  const state = { asked: 0, last: null as DecisionRequest<QuestionMap> | null };
  const jev = {
    async ask(req: DecisionRequest<QuestionMap>) {
      state.asked += 1;
      state.last = req;
      if (p === null) return null;
      const answers = parseAnswers(req.questions, {
        answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { noul: p }])),
      });
      return answers ? { answers, model: "scripted" } : null;
    },
  } as unknown as Decider;
  return { jev, llm: null, get asked() { return state.asked; }, get last() { return state.last; } } as unknown as Engines & {
    asked: number;
    last: DecisionRequest<QuestionMap> | null;
  };
}

const GATES = Object.keys(SKIP_GATES) as Array<keyof typeof SKIP_GATES>;

async function main() {
  console.log("Every gate that is on, at its own threshold");
  for (const gate of GATES) {
    const at = SKIP_GATE_TUNING.skipAtOrBelow[gate];
    if (at === null) continue;
    check(`${gate}: a confident no skips the call`, await gateSkips(scripted(at / 2), gate, { x: "y" }));
    check(`${gate}: exactly at the threshold skips`, await gateSkips(scripted(at), gate, { x: "y" }));
    check(`${gate}: just above it does not`, !(await gateSkips(scripted(at + 0.01), gate, { x: "y" })));
    check(`${gate}: a confident yes runs the call`, !(await gateSkips(scripted(0.99), gate, { x: "y" })));
  }

  console.log("\nA gate turned off in the catalog");
  const off = GATES.filter((g) => SKIP_GATE_TUNING.skipAtOrBelow[g] === null);
  check("at least the brief gate ships off (measured, does not work)", off.includes("brief"));
  for (const gate of off) {
    const spy = scripted(0.0);
    check(`${gate}: never skips, however sure the answer`, !(await gateSkips(spy, gate, { x: "y" })));
    check(`${gate}: and is not asked at all, so it costs nothing`, spy.asked === 0);
  }

  console.log("\nNo decision model: nothing is ever skipped");
  for (const gate of GATES) {
    check(`${gate}: no engines → the call runs`, !(await gateSkips(NO_ENGINES, gate, { x: "y" })));
  }
  const none = scripted(null);
  check("a decider that gives no answer → the call runs", !(await gateSkips(none, "dates", { x: "y" })));
  check("…and it was actually asked", none.asked === 1);
  check("no engines are not asked at all", (await gateProbability(NO_ENGINES, "dates", { x: "y" })) === null);

  console.log("\nA thrown error is not a skip");
  const throwing: Engines = {
    jev: { async ask() { throw new Error("upstream said no"); } },
    llm: null,
  };
  check("an exploding decider runs the call", !(await gateSkips(throwing, "starters", { x: "y" })));

  console.log("\nThe LLM never answers a gate");
  const withLlm: Engines = {
    jev: null,
    llm: { async ask() { throw new Error("the chat model must never be asked to gate a chat-model call"); } },
  };
  check("an account with a chat model but no Jev runs the call", !(await gateSkips(withLlm, "enrich", { x: "y" })));

  console.log("\nWhat the gate sends");
  const spy = scripted(0.9);
  await gateSkips(spy, "timeline", { messages: "hello" });
  check("one question, named for the answer", Object.keys(spy.last?.questions ?? {}).join() === "yes");
  check("the timeline gate uses its own operation", spy.last?.operation === "import.linkedin.timeline.decide");
  check("the state is passed through untouched", JSON.stringify(spy.last?.state) === JSON.stringify({ messages: "hello" }));
  check("each gate has its own operation", new Set(await Promise.all(GATES.map(async (g) => {
    const s2 = scripted(0.9);
    await gateProbability(s2, g, {});
    return s2.last?.operation;
  }))).size === GATES.length);

  console.log("\nWork-history gates ship off (spec 2026-11-10), still measurable");
  for (const [gate, operation] of [
    ["workHistoryRecheck", "contact.work_history.recheck.gate"],
    ["workHistoryVerify", "contact.work_history.verify.gate"],
  ] as const) {
    check(`${gate}: threshold is null`, SKIP_GATE_TUNING.skipAtOrBelow[gate] === null);
    const off = scripted(0.01);
    check(`${gate}: an off gate never skips`, !(await gateSkips(off, gate, {})));
    check(`${gate}: an off gate is never asked`, off.asked === 0);
    const measured = scripted(0.2);
    check(`${gate}: the eval still reads its probability`, (await gateProbability(measured, gate, {})) === 0.2);
    check(`${gate}: asked under its own operation`, measured.last?.operation === operation, measured.last?.operation);
  }

  console.log("\nThe eval fixture can calibrate the work-history gates");
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), "scripts", "eval-fixtures", "ai-skip-gates-eval.json"), "utf8"),
  ) as { cases: Array<{ id: string; gate: string; skip: boolean; state: Record<string, unknown> }> };
  check("every case names a real gate", fixture.cases.every((c) => c.gate in SKIP_GATES));
  check("case ids are unique", new Set(fixture.cases.map((c) => c.id)).size === fixture.cases.length);
  for (const [gate, min, keys] of [
    ["workHistoryRecheck", 24, ["contact", "last_checked", "since_last_check"]],
    ["workHistoryVerify", 20, ["contact", "first_answer"]],
  ] as const) {
    const cases = fixture.cases.filter((c) => c.gate === gate);
    check(`${gate}: at least ${min} cases`, cases.length >= min, cases.length);
    check(`${gate}: at least 10 that must NOT be skipped`, cases.filter((c) => !c.skip).length >= 10, cases.filter((c) => !c.skip).length);
    check(`${gate}: every state has the call site's keys`, cases.every((c) => keys.every((k) => k in c.state)));
  }

  console.log("\nLong inputs");
  const long = "x".repeat(SKIP_GATE_TUNING.inputChars + 5_000);
  check("gateText trims to the cap", gateText(long).length === SKIP_GATE_TUNING.inputChars);
  check("a short input is untouched", gateText("abc") === "abc");

  console.log("\nThresholds ship conservative");
  for (const gate of GATES) {
    const at = SKIP_GATE_TUNING.skipAtOrBelow[gate];
    // A gate may never skip on a coin flip: "unsure" has to mean the call runs.
    check(`${gate}: off, or skips only below even odds`, at === null || at < 0.5);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll skip-gate checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
