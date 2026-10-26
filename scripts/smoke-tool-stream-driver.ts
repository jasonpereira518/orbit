/**
 * The streamed-round readers in `src/lib/ai-tools-stream.ts`, replayed from streams shaped
 * exactly as each provider sends them: prose, then tool calls, then prose again — the order
 * an answer that looks something up mid-sentence produces.
 *
 * Pure: no network, no key. Run: npx tsx scripts/smoke-tool-stream-driver.ts
 */
import "./smoke/_env";
import { readAnthropicText, readGeminiRound, readOpenAiRound } from "../src/lib/ai-tools-stream";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function* from<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

async function main() {
  console.log("Anthropic: text deltas stream, nothing else does");
  {
    const seen: string[] = [];
    await readAnthropicText(
      from([
        { type: "message_start" },
        { type: "content_block_start", index: 0 },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "your events." } },
        { type: "content_block_start", index: 1 },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"tab":"up' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'coming"}' } },
        { type: "message_stop" },
      ] as never),
      (d) => seen.push(d)
    );
    check("only the prose reaches the user", seen.join("") === "Let me check your events.", JSON.stringify(seen));
  }

  console.log("\nOpenAI: tool calls assembled by index from fragments");
  {
    const seen: string[] = [];
    const chunk = (delta: object, usage?: object) => ({ choices: [{ index: 0, delta }], ...(usage ? { usage } : {}) });
    const round = await readOpenAiRound(
      from([
        chunk({ content: "Checking " }),
        chunk({ content: "two things." }),
        chunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "list_events", arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 1, id: "call_b", function: { name: "get_contact", arguments: '{"contactId":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"tab":"upcoming"}' } }] }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: '"c1"}' } }] }),
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
      ] as never),
      (d) => seen.push(d)
    );
    check("prose streamed as it arrived", seen.join("") === "Checking two things." && round.text === "Checking two things.");
    check(
      "both calls, in index order, with parsed arguments",
      JSON.stringify(round.calls) ===
        JSON.stringify([
          { id: "call_a", name: "list_events", args: { tab: "upcoming" } },
          { id: "call_b", name: "get_contact", args: { contactId: "c1" } },
        ]),
      JSON.stringify(round.calls)
    );
    check(
      "the assistant message echoes the calls with their raw argument strings",
      round.message.tool_calls?.length === 2 &&
        (round.message.tool_calls[1] as { function: { arguments: string } }).function.arguments === '{"contactId":"c1"}' &&
        round.message.content === "Checking two things."
    );
    check("usage is taken from the final chunk", JSON.stringify(round.usage) === JSON.stringify({ prompt_tokens: 100, completion_tokens: 20 }));

    const broken = await readOpenAiRound(
      from([chunk({ tool_calls: [{ index: 0, id: "x", function: { name: "get_contact", arguments: '{"contactId": ' } }] })] as never),
      () => {}
    );
    check("malformed arguments pass on as the raw string, for the registry to reject", broken.calls[0]?.args === '{"contactId": ');

    const plain = await readOpenAiRound(from([chunk({ content: "Done." })] as never), () => {});
    check("a round with no calls has no tool_calls key", plain.calls.length === 0 && !("tool_calls" in plain.message));
  }

  console.log("\nGemini: calls across chunks, thoughts never streamed, every part kept");
  {
    const seen: string[] = [];
    const round = await readGeminiRound(
      from([
        { candidates: [{ content: { role: "model", parts: [{ text: "planning…", thought: true }] } }] },
        { candidates: [{ content: { role: "model", parts: [{ text: "One moment, " }] } }] },
        { candidates: [{ content: { role: "model", parts: [{ text: "looking that up." }] } }] },
        {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ functionCall: { name: "list_events", args: { tab: "past" } }, thoughtSignature: "sig-1" }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 50 },
        },
      ] as never),
      (d) => seen.push(d),
      "call-3"
    );
    check("only reply text streams, never a thought", seen.join("") === "One moment, looking that up.", JSON.stringify(seen));
    check(
      "a call without an id gets a synthetic one",
      JSON.stringify(round.calls) === JSON.stringify([{ id: "call-3-0", name: "list_events", args: { tab: "past" } }]),
      JSON.stringify(round.calls)
    );
    check(
      "the history keeps every part, thought signature included",
      round.content.parts?.length === 4 && JSON.stringify(round.content).includes("sig-1")
    );
    check("the last chunk is kept for usage", JSON.stringify(round.last).includes("promptTokenCount"));
  }

  if (failures) {
    console.error(`\n${failures} tool-stream check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll tool-stream checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
