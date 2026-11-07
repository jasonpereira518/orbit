/**
 * Reading one STREAMED tool-calling round, per provider — the pure half of the streaming
 * driver in `@/lib/ai-tools` (`DriverInput.onText`).
 *
 * The answer loop (`@/lib/chat-agent-loop`) streams the model's prose to the person while the
 * same round may end in tool calls. Each provider streams both differently: Anthropic as typed
 * content-block events, OpenAI as `tool_calls` fragments keyed by index whose arguments arrive
 * as JSON-string pieces, Gemini as whole `functionCall` parts spread across chunks. These
 * functions turn one round's stream into the same `{ text, calls }` shape plus whatever the
 * provider needs echoed back next round — and nothing else, so a recorded stream replays them
 * with no key (`scripts/smoke-tool-stream-driver.ts`).
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Content, Part } from "@google/genai";
import type OpenAI from "openai";
import type { ToolCall } from "@/lib/ai-tools";

type OpenAiChunk = OpenAI.Chat.Completions.ChatCompletionChunk;

/** Text deltas from an Anthropic stream. Tool calls come from the final message, which the SDK assembles. */
export async function readAnthropicText(
  events: AsyncIterable<Anthropic.MessageStreamEvent>,
  onText: (delta: string) => void
): Promise<void> {
  for await (const event of events) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
      onText(event.delta.text);
    }
  }
}

/**
 * One OpenAI-shaped round: text streamed as it arrives, tool calls assembled by index.
 *
 * A call's id and name arrive on its first fragment and its arguments as string pieces after,
 * so they are concatenated and parsed once the stream ends. Arguments that do not parse are
 * passed on as the raw string — the registry's validation then rejects them with a message
 * the model can correct from, exactly as the non-streaming driver does.
 */
export async function readOpenAiRound(
  chunks: AsyncIterable<OpenAiChunk>,
  onText: (delta: string) => void
): Promise<{
  text: string;
  calls: ToolCall[];
  message: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
  usage: unknown;
}> {
  let text = "";
  let usage: unknown = null;
  const parts = new Map<number, { id: string; name: string; args: string }>();
  for await (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;
    if (delta.content) {
      text += delta.content;
      onText(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const part = parts.get(tc.index) ?? { id: "", name: "", args: "" };
      if (tc.id) part.id = tc.id;
      if (tc.function?.name) part.name += tc.function.name;
      if (tc.function?.arguments) part.args += tc.function.arguments;
      parts.set(tc.index, part);
    }
  }
  const ordered = [...parts.entries()].sort(([a], [b]) => a - b).map(([, p]) => p);
  const calls: ToolCall[] = ordered.map((p, i) => {
    let args: unknown = p.args;
    try {
      args = JSON.parse(p.args || "{}");
    } catch {
      // left as the raw string
    }
    return { id: p.id || `call-${i}`, name: p.name, args };
  });
  const message: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
    role: "assistant",
    content: text || null,
    ...(ordered.length
      ? {
          tool_calls: ordered.map((p, i) => ({
            id: p.id || `call-${i}`,
            type: "function" as const,
            function: { name: p.name, arguments: p.args || "{}" },
          })),
        }
      : {}),
  };
  return { text, calls, message, usage };
}

/**
 * One Gemini round: text parts streamed (never `thought` parts, which are reasoning, not the
 * reply), function calls collected, and EVERY part kept for the history — a thinking model
 * attaches a `thoughtSignature` to its function-call part, and a next round sent without it
 * is rejected.
 */
export async function readGeminiRound(
  chunks: AsyncIterable<{ candidates?: Array<{ content?: Content }> }>,
  onText: (delta: string) => void,
  idPrefix: string
): Promise<{ text: string; calls: ToolCall[]; content: Content; last: unknown }> {
  let text = "";
  let last: unknown = null;
  const parts: Part[] = [];
  const calls: ToolCall[] = [];
  for await (const chunk of chunks) {
    last = chunk;
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
      parts.push(part);
      if (typeof part.text === "string" && !part.thought && part.text) {
        text += part.text;
        onText(part.text);
      }
      if (part.functionCall) {
        calls.push({
          id: part.functionCall.id ?? `${idPrefix}-${calls.length}`,
          name: part.functionCall.name ?? "",
          args: part.functionCall.args ?? {},
        });
      }
    }
  }
  return { text, calls, content: { role: "model", parts }, last };
}
