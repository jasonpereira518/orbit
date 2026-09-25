/**
 * Tool calling, for the three providers Orbit talks to directly.
 *
 * WHY NOT THE VERCEL AI SDK. `ai.ts` already owns everything the SDK would have to be
 * re-taught: `withUsage`'s per-call token report into `usage_events`, `runOnGrant` with its
 * WeakMap-guarded BYOK keys, the per-operation thinking dials tuned by a measured eval, and
 * the error translation every surface depends on. The SDK's `providerOptions` keeps the
 * three-way branch anyway. So this adds one more branch per provider next to the ones that
 * exist, rather than moving every AI call in the product onto a new abstraction to get one
 * feature.
 *
 * THE SHAPE. A `ToolDriver` holds one conversation in its provider's NATIVE message format
 * and exposes two things: take a step, and hand back tool results. Keeping the native shape
 * rather than translating through a neutral one means each provider's quirks (Anthropic's
 * `tool_use` blocks, OpenAI's `tool_calls` with string-encoded arguments, Gemini's
 * `functionCall` parts) are handled once, where they occur. The loop that decides how many
 * rounds to run lives in `@/lib/chat-tool-loop` and never sees any of it — which is also what
 * makes the loop testable with a fake driver and no key.
 *
 * Non-streaming on purpose: nothing a gather round writes is shown to the user. The answer
 * that IS shown is written afterwards by `chatWithNetworkStream`, unchanged.
 */
import { z, type ZodRawShape } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { Content, FunctionDeclaration } from "@google/genai";
import {
  anthropicClient,
  geminiClient,
  openaiClient,
  resolveAiAccess,
  runOnGrant,
} from "@/lib/ai-access";
import { geminiThinking, translatingProviderErrors } from "@/lib/ai";
import { modelForOperation } from "@/lib/ai-models";
import type { AiOperationId } from "@/lib/ai-operations";
import { aiOperationThinking } from "@/lib/ai-operations";
import { anthropicAcceptsTemperature } from "@/lib/ai-providers";
import { openaiCompletionOptions } from "@/lib/ai-request-options";
import { aiProviderLabel } from "@/lib/errors";
import {
  tokensFromAnthropic,
  tokensFromGemini,
  tokensFromOpenAi,
  withUsage,
} from "@/lib/usage-events";

export type ModelTool = {
  name: string;
  description: string;
  /** The zod shape the registry already declares; converted to JSON Schema once, here. */
  inputSchema: ZodRawShape;
};

export type ToolCall = {
  /** The provider's id for the call, echoed back with its result. */
  id: string;
  name: string;
  args: unknown;
};

export type ToolStep = {
  calls: ToolCall[];
  /** Any prose the model wrote this round. Discarded by the gather loop; kept for tests. */
  text: string;
};

export type ToolDriver = {
  step(signal: AbortSignal): Promise<ToolStep>;
  /** One result per call from the last step, in any order. */
  addResults(results: Array<{ call: ToolCall; content: string }>): void;
};

/**
 * JSON Schema for a tool's arguments, as the model should produce them.
 *
 * `io: "input"` so a field with a `.default()` is optional in what the model sees — the
 * registry validates and fills defaults when the call comes back. `$schema` is dropped: two
 * of the three providers reject unknown top-level keywords.
 */
export function toolParameters(shape: ZodRawShape): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape), { io: "input" }) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = schema;
  return rest;
}

type DriverInput = {
  userId: string;
  operation: AiOperationId;
  system: string;
  user: string;
  tools: ModelTool[];
  temperature?: number;
  maxOutputTokens?: number;
};

export async function createToolDriver(input: DriverInput): Promise<ToolDriver> {
  const grant = await (await resolveAiAccess(input.userId)).completion(input.operation);
  const { provider, keyOwner } = grant;
  const model = modelForOperation(input.operation, grant);
  const temperature = input.temperature ?? 0.1;
  const maxOutputTokens = input.maxOutputTokens ?? 1024;
  const usage = {
    userId: input.userId,
    operation: input.operation,
    provider,
    model,
    kind: "completion" as const,
    keyOwner,
  };
  /** Every round is its own usage row, so a multi-round answer's cost is visible per call. */
  const metered = <T>(signal: AbortSignal, work: (report: Parameters<Parameters<typeof withUsage>[1]>[0]) => Promise<T>) =>
    runOnGrant(
      grant,
      withUsage(usage, (report) => translatingProviderErrors(aiProviderLabel(provider), () => work(report)), {
        cancelSignal: signal,
      })
    );

  if (provider === "anthropic") {
    const client = await anthropicClient(grant);
    const tools: Anthropic.Tool[] = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toolParameters(t.inputSchema) as Anthropic.Tool.InputSchema,
    }));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: input.user }];
    return {
      async step(signal) {
        const response = await metered(signal, async (report) => {
          const r = await client.messages.create(
            {
              model,
              max_tokens: maxOutputTokens,
              ...(anthropicAcceptsTemperature(model) ? { temperature } : {}),
              system: input.system,
              tools,
              messages,
            },
            { signal }
          );
          report(tokensFromAnthropic(r));
          return r;
        });
        // The assistant turn goes back verbatim: Anthropic requires every `tool_use` block to
        // be answered by a `tool_result` in the next user turn, keyed by its id.
        messages.push({ role: "assistant", content: response.content });
        return {
          calls: response.content.flatMap((b) =>
            b.type === "tool_use" ? [{ id: b.id, name: b.name, args: b.input }] : []
          ),
          text: response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
        };
      },
      addResults(results) {
        if (!results.length) return;
        messages.push({
          role: "user",
          content: results.map((r) => ({
            type: "tool_result" as const,
            tool_use_id: r.call.id,
            content: r.content,
          })),
        });
      },
    };
  }

  if (provider === "openai") {
    const client = await openaiClient(grant);
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = input.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: toolParameters(t.inputSchema) },
    }));
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ];
    return {
      async step(signal) {
        const response = await metered(signal, async (report) => {
          const r = await client.chat.completions.create(
            {
              model,
              ...openaiCompletionOptions(model, {
                temperature,
                maxOutputTokens,
                thinking: aiOperationThinking(input.operation),
              }),
              tools,
              messages,
            },
            { signal }
          );
          report(tokensFromOpenAi(r));
          return r;
        });
        const message = response.choices[0]?.message;
        if (message) messages.push(message);
        const calls: ToolCall[] = [];
        for (const tc of message?.tool_calls ?? []) {
          if (tc.type !== "function") continue;
          // Arguments arrive as a JSON STRING. A malformed one is passed on as a raw string so
          // the registry's validation rejects it with a message the model can correct from,
          // rather than this throwing and ending the round.
          let args: unknown = tc.function.arguments;
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            // left as the raw string
          }
          calls.push({ id: tc.id, name: tc.function.name, args });
        }
        return { calls, text: message?.content ?? "" };
      },
      addResults(results) {
        for (const r of results) {
          messages.push({ role: "tool", tool_call_id: r.call.id, content: r.content });
        }
      },
    };
  }

  // Gemini.
  const client = await geminiClient(grant);
  const functionDeclarations: FunctionDeclaration[] = input.tools.map((t) => ({
    name: t.name,
    description: t.description,
    // The full JSON Schema dialect, rather than `parameters`, which takes only Gemini's
    // OpenAPI subset and would reject what zod emits for unions and formats.
    parametersJsonSchema: toolParameters(t.inputSchema),
  }));
  const contents: Content[] = [{ role: "user", parts: [{ text: input.user }] }];
  return {
    async step(signal) {
      const response = await metered(signal, async (report) => {
        const r = await client.models.generateContent({
          model,
          contents,
          config: {
            abortSignal: signal,
            temperature,
            maxOutputTokens,
            systemInstruction: input.system,
            tools: [{ functionDeclarations }],
            ...geminiThinking(model, input.operation),
          },
        });
        report(tokensFromGemini(r));
        return r;
      });
      const content = response.candidates?.[0]?.content;
      if (content) contents.push(content);
      const calls = (response.functionCalls ?? []).map((fc, i) => ({
        // Gemini's ids are optional; a synthetic one keeps results matched to calls within
        // the round, and the response part is keyed by name as Gemini expects.
        id: fc.id ?? `call-${contents.length}-${i}`,
        name: fc.name ?? "",
        args: fc.args ?? {},
      }));
      // Text read from the parts directly, not through `response.text`: that getter logs a
      // "there are non-text parts functionCall" warning on every round that makes a call —
      // i.e. on every research round, in production logs — and returns the same string.
      const text = (content?.parts ?? [])
        // `thought` parts carry the model's reasoning as text on thinking models; they are
        // not its reply, and `response.text` excludes them too.
        .flatMap((p) => (typeof p.text === "string" && !p.thought ? [p.text] : []))
        .join("");
      return { calls, text };
    },
    addResults(results) {
      if (!results.length) return;
      contents.push({
        role: "user",
        parts: results.map((r) => ({
          functionResponse: {
            id: r.call.id,
            name: r.call.name,
            response: { result: r.content },
          },
        })),
      });
    },
  };
}
