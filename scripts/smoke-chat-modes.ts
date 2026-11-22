/**
 * Quick and Deep answers, and the web switch (`CHAT_MODES` in `src/lib/chat-agent-loop.ts`).
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-chat-modes.ts
 */
import { readFileSync } from "node:fs";
import {
  AGENT_BOUNDS,
  AGENT_RULES,
  ANSWER_ENDS_BY_MS,
  CHAT_MODES,
  LOOKUPS_END_BY_MS,
  WEB_LOOKUP_LIMIT,
  agentRulesFor,
  answerDeadlineMs,
  runChatAgent,
  webLimitFor,
} from "../src/lib/chat-agent-loop";
import type { ToolCall, ToolDriver } from "../src/lib/ai-tools";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` (${detail})`}`);
  if (!ok) failures++;
}

async function main() {
  const route = readFileSync("src/app/api/chat/route.ts", "utf8");
  const loop = readFileSync("src/lib/chat-agent-loop.ts", "utf8");
  const maxDurationMs = Number(/export const maxDuration = (\d+);/.exec(route)?.[1] ?? 0) * 1000;

  console.log("Budgets");
  check(
    "quick is exactly what chat did before modes",
    CHAT_MODES.quick.bounds === AGENT_BOUNDS &&
      CHAT_MODES.quick.answerEndsByMs === ANSWER_ENDS_BY_MS &&
      CHAT_MODES.quick.lookupsEndByMs === LOOKUPS_END_BY_MS &&
      CHAT_MODES.quick.webLookups === WEB_LOOKUP_LIMIT.max,
  );
  check(
    "deep gets more of everything",
    CHAT_MODES.deep.bounds.maxRounds > AGENT_BOUNDS.maxRounds &&
      CHAT_MODES.deep.bounds.maxCalls > AGENT_BOUNDS.maxCalls &&
      CHAT_MODES.deep.webLookups > WEB_LOOKUP_LIMIT.max &&
      CHAT_MODES.deep.answerEndsByMs > ANSWER_ENDS_BY_MS,
  );
  for (const mode of ["quick", "deep"] as const) {
    const m = CHAT_MODES[mode];
    check(`${mode}: lookups stop before the answer is cut`, m.lookupsEndByMs < m.answerEndsByMs);
    check(
      `${mode}: the answer is cut at least 30s inside the route's maxDuration, leaving time to save it`,
      maxDurationMs > 0 && m.answerEndsByMs <= maxDurationMs - 30_000,
      `${m.answerEndsByMs} vs ${maxDurationMs}`,
    );
  }
  check("the deadline follows the mode", answerDeadlineMs(1000, 1000, "deep") === CHAT_MODES.deep.answerEndsByMs && answerDeadlineMs(1000, 1000) === ANSWER_ENDS_BY_MS);
  check("a spent deadline is floored, never negative", answerDeadlineMs(0, 10_000_000, "deep") === 1_000);

  console.log("\nWhat the model is told");
  check("quick with web on is the standing rules, unchanged", agentRulesFor("quick", true) === AGENT_RULES);
  const off = agentRulesFor("quick", false);
  check("web off: says so, and names no web tool", off.includes("switched web search off") && ![...WEB_LOOKUP_LIMIT.tools].some((t) => off.includes(t)), off.slice(0, 120));
  const deep = agentRulesFor("deep", true);
  check("deep: allows its own number of web lookups and asks for thoroughness", deep.includes(`at most ${CHAT_MODES.deep.webLookups} per answer`) && deep.includes("thorough answer"));
  check("deep with web off still names no web tool", ![...WEB_LOOKUP_LIMIT.tools].some((t) => agentRulesFor("deep", false).includes(t)));

  console.log("\nWhat the loop enforces");
  {
    // A model that asks for a web lookup every round, for as long as it is allowed rounds.
    let n = 0;
    const driver: ToolDriver = {
      async step(_signal, opts) {
        if (opts?.noTools) return { calls: [], text: "done" };
        const call: ToolCall = { id: `c${++n}`, name: "research_person", args: { name: `Person ${n}` } };
        return { calls: [call], text: "" };
      },
      addResults() {},
      addUserText() {},
    };
    let ran = 0;
    const far = Date.now() + 600_000;
    const run = await runChatAgent({
      driver,
      execute: async () => {
        ran++;
        return { ok: true, result: {} };
      },
      lookupDeadline: far,
      answerDeadline: far,
      signal: new AbortController().signal,
      bounds: CHAT_MODES.deep.bounds,
      webLimit: webLimitFor("deep"),
    });
    check("deep runs its web lookups and no more", ran === CHAT_MODES.deep.webLookups, `${ran} ran over ${run.rounds} rounds`);
    check("deep is still bounded in rounds", run.rounds <= CHAT_MODES.deep.bounds.maxRounds, String(run.rounds));
  }
  check("quick keeps the one-lookup limit object itself", webLimitFor("quick") === WEB_LOOKUP_LIMIT);
  check(
    "web off removes the web tools from what the model is offered",
    /const tools = web \? offered : offered\.filter\(\(t\) => !WEB_LOOKUP_LIMIT\.tools\.has\(t\.name\)\);/.test(loop),
  );

  console.log("\nThe route");
  check("anything but \"deep\" is a quick answer", /const mode: ChatMode = body\?\.mode === "deep" \? "deep" : "quick";/.test(route));
  // Web search is decided per message now (smoke-chat-web-decision): auto unless the client says on or off.
  check("web is the chat's choice, auto when absent", /const webChoice = parseWebChoice\(body\?\.web\);/.test(route));
  check("both reach the answer", /steer,\s*mode,\s*web: webTurn\.on,/.test(route));

  console.log(failures === 0 ? "\nsmoke-chat-modes: all checks passed" : `\nsmoke-chat-modes: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
