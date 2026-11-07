/**
 * Why a model stopped, the same way for every provider.
 *
 * Before this, no call read `finish_reason` / `stop_reason` / `finishReason`: a reply cut off
 * at `maxOutputTokens` went through `repairTruncatedJson`, which closes the open brackets, and
 * came back as valid JSON with the last person, date or sentence missing — recorded as a
 * success. A refusal was an empty answer or, worse, a normal-looking one.
 *
 * Pure: no SDKs, no env, no DB. `ai.ts` maps each provider's response through these and
 * `assertUsableFinish` turns the two outcomes nobody can use into typed errors.
 */
import { AI_INCOMPLETE_MESSAGE } from "@/lib/errors";

export type AiFinish = "stop" | "length" | "refusal" | "safety" | "tool" | "other";

/** What a person reads when the model declined. Never the provider's own words. */
export const AI_REFUSAL_MESSAGE = "The AI declined to answer that — try rewording it";

/** `truncated`: ran into the output cap. `refusal`: declined, or stopped by a safety filter. */
export class AiFinishError extends Error {
  constructor(readonly kind: "truncated" | "refusal", message: string) {
    super(message);
    this.name = "AiFinishError";
  }
}

const upper = (v: unknown) => String(v ?? "").toUpperCase();

/** Gemini `candidates[0].finishReason` (a string enum), or a blocked prompt. */
export function geminiFinish(response: unknown): AiFinish {
  const r = response as {
    candidates?: Array<{ finishReason?: unknown }>;
    promptFeedback?: { blockReason?: unknown };
  } | null;
  const reason = upper(r?.candidates?.[0]?.finishReason);
  if (!reason) return r?.promptFeedback?.blockReason ? "safety" : "stop";
  if (reason.includes("MAX_TOKENS")) return "length";
  if (reason.endsWith("STOP")) return "stop";
  if (/SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(reason)) return "safety";
  if (/TOOL_CALL|MALFORMED_FUNCTION/.test(reason)) return "tool";
  return "other";
}

/** OpenAI-shaped chat completion choice (`finish_reason`, and `message.refusal`). */
export function openaiFinish(choice: unknown): AiFinish {
  const c = choice as { finish_reason?: unknown; message?: { refusal?: unknown } } | null | undefined;
  if (typeof c?.message?.refusal === "string" && c.message.refusal.trim()) return "refusal";
  switch (c?.finish_reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "safety";
    case "tool_calls":
    case "function_call":
      return "tool";
    case null:
    case undefined:
      return "stop";
    default:
      return "other";
  }
}

/** OpenAI Responses API (`status`, `incomplete_details.reason`). */
export function openaiResponsesFinish(response: unknown): AiFinish {
  const r = response as { status?: unknown; incomplete_details?: { reason?: unknown } | null } | null;
  if (r?.status !== "incomplete") return "stop";
  const reason = String(r.incomplete_details?.reason ?? "");
  if (reason === "max_output_tokens") return "length";
  if (reason === "content_filter") return "safety";
  return "other";
}

/** Anthropic `stop_reason`. */
export function anthropicFinish(stopReason: unknown): AiFinish {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
    case null:
    case undefined:
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "refusal";
    case "tool_use":
      return "tool";
    default:
      return "other";
  }
}

/**
 * Throws for the two stops whose output must not be used as an answer. `other` and `tool`
 * pass: an unrecognised reason is not evidence of a broken answer, and the existing empty-
 * and parse-failure checks still run on it.
 */
export function assertUsableFinish(finish: AiFinish): void {
  if (finish === "length") throw new AiFinishError("truncated", AI_INCOMPLETE_MESSAGE);
  if (finish === "refusal" || finish === "safety") throw new AiFinishError("refusal", AI_REFUSAL_MESSAGE);
}
