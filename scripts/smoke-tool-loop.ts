/**
 * The research loop's bounds, with a scripted fake provider.
 *
 * Each bound here is a promise to the user that holds whatever the model does: it cannot run
 * more rounds than allowed, make more lookups than allowed, spend the time reserved for the
 * answer, or turn a provider failure into an error card when some evidence was already in
 * hand. And one promise to the provider: every tool call it made gets a result — Anthropic
 * and OpenAI both reject a conversation where one is missing.
 *
 * Pure: a fake driver and a fake executor. Run: npx tsx scripts/smoke-tool-loop.ts
 */
import type { ToolCall, ToolDriver, ToolStep } from "../src/lib/ai-tools";
import { runToolLoop } from "../src/lib/chat-tool-loop";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

let idSeq = 0;
function call(name: string, args: unknown = {}): ToolCall {
  return { id: `c${++idSeq}`, name, args };
}

/** A driver that plays back scripted rounds and records what it was sent. */
function scripted(rounds: Array<ToolStep | Error>) {
  let i = 0;
  const sentBack: Array<Array<{ call: ToolCall; content: string }>> = [];
  const asked: ToolCall[][] = [];
  const driver: ToolDriver = {
    async step() {
      const next = rounds[i++] ?? { calls: [], text: "DONE" };
      if (next instanceof Error) throw next;
      asked.push(next.calls);
      return next;
    },
    addResults(results) {
      sentBack.push(results);
    },
  };
  return { driver, sentBack, asked, stepsTaken: () => i };
}

const okExec = async (c: ToolCall) => ({ ok: true, result: { from: c.name, args: c.args } });
const far = () => Date.now() + 60_000;
const base = { maxRounds: 3, maxCalls: 6, maxResultChars: 2000 };

async function main() {
  // --- the model says it is done ---------------------------------------------------------
  {
    const s = scripted([{ calls: [call("search_notes", { query: "series a" })], text: "" }]);
    const out = await runToolLoop(s.driver, okExec, { ...base, deadline: far() });
    check("stops when the model makes no more lookups", out.stoppedBy === "done", out.stoppedBy);
    check("and reports the lookup it made", out.calls.length === 1 && out.calls[0].ok);
    check("two rounds: the lookup, then DONE", out.rounds === 2, String(out.rounds));
  }

  // --- the round cap -------------------------------------------------------------------------
  {
    const forever = Array.from({ length: 10 }, (_, n) => ({ calls: [call("search_notes", { query: `q${n}` })], text: "" }));
    const s = scripted(forever);
    const out = await runToolLoop(s.driver, okExec, { ...base, maxCalls: 50, deadline: far() });
    check("a model that never stops asking stops at the round cap", out.stoppedBy === "rounds" && out.rounds === 3, `${out.stoppedBy} after ${out.rounds}`);
  }

  // --- the call cap, and every call still gets an answer -------------------------------------
  {
    const greedy = { calls: Array.from({ length: 5 }, (_, n) => call("search_contacts", { query: `p${n}` })), text: "" };
    const s = scripted([greedy, greedy]);
    let executed = 0;
    const counting = async (c: ToolCall) => {
      executed++;
      return okExec(c);
    };
    const out = await runToolLoop(s.driver, counting, { ...base, maxCalls: 3, deadline: far() });
    check("a round asking for five lookups runs only as many as the budget allows", executed === 3, String(executed));
    check("and the loop stops on the call budget", out.stoppedBy === "calls", out.stoppedBy);
    check(
      "every call the model made still got a result back — the provider rejects a missing one",
      s.sentBack[0]?.length === 5,
      String(s.sentBack[0]?.length)
    );
    check(
      "and the unrun ones say why, so the model answers with what it has",
      s.sentBack[0].slice(3).every((r) => r.content.includes("budget")),
      s.sentBack[0].slice(3).map((r) => r.content).join(" | ")
    );
  }

  // --- the deadline --------------------------------------------------------------------------
  {
    const s = scripted([{ calls: [call("search_notes")], text: "" }]);
    const out = await runToolLoop(s.driver, okExec, { ...base, deadline: Date.now() - 1 });
    check("a spent deadline starts no round at all", out.stoppedBy === "deadline" && s.stepsTaken() === 0, `${out.stoppedBy}, ${s.stepsTaken()} steps`);
  }
  {
    // The clock moves past the deadline during the first round's lookups.
    let t = 1_000;
    const s = scripted([
      { calls: [call("search_notes", { query: "a" })], text: "" },
      { calls: [call("search_notes", { query: "b" })], text: "" },
    ]);
    const slow = async (c: ToolCall) => {
      t += 10_000;
      return okExec(c);
    };
    const out = await runToolLoop(s.driver, slow, { ...base, deadline: 5_000, now: () => t });
    check("a round that runs past the deadline is the last one", out.stoppedBy === "deadline" && s.stepsTaken() === 1, `${out.stoppedBy}, ${s.stepsTaken()} steps`);
    check("and what it found is kept", out.calls.length === 1, String(out.calls.length));
  }

  // --- a provider failure keeps the evidence -------------------------------------------------
  {
    const s = scripted([{ calls: [call("search_notes", { query: "kept" })], text: "" }, new Error("503 from provider")]);
    const out = await runToolLoop(s.driver, okExec, { ...base, deadline: far() });
    check("a provider error ends the loop as an error, not a throw", out.stoppedBy === "error", out.stoppedBy);
    check("and the evidence from the round before survives", out.calls.length === 1, String(out.calls.length));
  }

  // --- a tool that throws is reported to the model, not fatal ---------------------------------
  {
    const s = scripted([{ calls: [call("broken"), call("fine")], text: "" }]);
    const exec = async (c: ToolCall) => {
      if (c.name === "broken") throw new Error("database hiccup");
      return okExec(c);
    };
    const out = await runToolLoop(s.driver, exec, { ...base, deadline: far() });
    check("one lookup throwing does not end the loop", out.stoppedBy === "done", out.stoppedBy);
    check(
      "it goes back to the model as an error it can route around",
      s.sentBack[0].some((r) => r.content.includes("database hiccup")),
      JSON.stringify(s.sentBack[0])
    );
    check("and is marked not ok, so it never reaches the evidence", out.calls.find((c) => c.call.name === "broken")?.ok === false);
  }

  // --- repeats are answered, not re-run ------------------------------------------------------
  {
    const s = scripted([
      { calls: [call("search_notes", { query: "same" })], text: "" },
      { calls: [call("search_notes", { query: "same" })], text: "" },
    ]);
    let executed = 0;
    const counting = async (c: ToolCall) => {
      executed++;
      return okExec(c);
    };
    const out = await runToolLoop(s.driver, counting, { ...base, deadline: far() });
    check("an identical lookup is not run twice", executed === 1, String(executed));
    check("nor counted twice in the evidence", out.calls.length === 1, String(out.calls.length));
    check(
      "and the model is told it already has it",
      s.sentBack[1]?.[0]?.content.includes("Same lookup"),
      s.sentBack[1]?.[0]?.content
    );
  }

  // --- results are capped before they go back ------------------------------------------------
  {
    const s = scripted([{ calls: [call("huge")], text: "" }]);
    const exec = async () => ({ ok: true, result: "x".repeat(50_000) });
    await runToolLoop(s.driver, exec, { ...base, maxResultChars: 1000, deadline: far() });
    check(
      "one oversized result cannot flood the conversation",
      s.sentBack[0][0].content.length < 1100,
      String(s.sentBack[0][0].content.length)
    );
  }

  // --- the user leaving stops the spend ------------------------------------------------------
  {
    const controller = new AbortController();
    controller.abort();
    const s = scripted([{ calls: [call("search_notes")], text: "" }]);
    const out = await runToolLoop(s.driver, okExec, { ...base, deadline: far(), signal: controller.signal });
    check("a closed tab starts no round", out.stoppedBy === "aborted" && s.stepsTaken() === 0, `${out.stoppedBy}, ${s.stepsTaken()}`);
  }

  console.log(failures === 0 ? "\nsmoke-tool-loop: all checks passed" : `\nsmoke-tool-loop: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
