import { after } from "next/server";
import { getDb } from "@/db";
import { usageEvents } from "@/db/schema";
import { estimateCostMicros } from "@/lib/ai-pricing";
import { classifyAiError } from "@/lib/errors";
import type { AiProvider } from "@/lib/ai-providers";

export type UsageKind =
  | "completion"
  | "multimodal"
  | "embedding"
  | "transcription";

/**
 * Token counts as reported by the provider.
 *
 * Every field is optional because two call sites genuinely cannot report them: Whisper
 * bills per second of audio and returns no usage object, and Gemini's `embedContent`
 * returns no `usageMetadata`. Those rows store null. Null is information; a fabricated
 * zero is a lie that would get summed into a total.
 */
export type TokenCounts = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
};

export type UsageMeta = {
  userId: string;
  operation: string;
  provider: AiProvider;
  model: string;
  kind: UsageKind;
  /** Whose API key paid. "orbit" only ever happens off-Vercel — prod is strictly BYOK. */
  keyOwner: "user" | "orbit";
};

type UsageRecord = UsageMeta &
  TokenCounts & {
    success: boolean;
    errorKind?: string | null;
    durationMs?: number | null;
  };

/**
 * Fire-and-forget write. Never throws, never blocks the response.
 *
 * Telemetry that can fail a user action is worse than no telemetry, so every failure path
 * here is swallowed deliberately.
 */
export function recordUsage(rec: UsageRecord): void {
  const write = async () => {
    try {
      const db = await getDb();
      await db.insert(usageEvents).values({
        userId: rec.userId,
        operation: rec.operation,
        provider: rec.provider,
        model: rec.model,
        kind: rec.kind,
        keyOwner: rec.keyOwner,
        inputTokens: rec.inputTokens ?? null,
        outputTokens: rec.outputTokens ?? null,
        cachedInputTokens: rec.cachedInputTokens ?? null,
        estimatedCostMicros: estimateCostMicros({
          model: rec.model,
          inputTokens: rec.inputTokens,
          outputTokens: rec.outputTokens,
          cachedInputTokens: rec.cachedInputTokens,
        }),
        success: rec.success ? 1 : 0,
        errorKind: rec.errorKind ?? null,
        durationMs: rec.durationMs ?? null,
      });
    } catch {
      // Telemetry must never surface as a user-visible failure.
    }
  };

  // `after()` throws outside a request scope, and `ai.ts` is reached from the import-job
  // processor and the process-stalled cron. Without this fallback, adding metrics would
  // turn those background paths into 500s.
  try {
    after(write);
  } catch {
    void write();
  }
}

/**
 * Wraps one provider call so both outcomes are recorded.
 *
 * The callback receives a `report` function because token counts live on the raw provider
 * response, which each branch consumes inline. Call `report(...)` right after the await;
 * if the call throws first, the failure is still recorded with whatever was reported.
 */
export async function withUsage<T>(
  meta: UsageMeta,
  run: (report: (tokens: TokenCounts) => void) => Promise<T>
): Promise<T> {
  const started = Date.now();
  let tokens: TokenCounts = {};
  const report = (t: TokenCounts) => {
    tokens = t;
  };

  try {
    const result = await run(report);
    recordUsage({
      ...meta,
      ...tokens,
      success: true,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (err) {
    recordUsage({
      ...meta,
      ...tokens,
      success: false,
      errorKind: classifyAiError(err),
      durationMs: Date.now() - started,
    });
    throw err;
  }
}

/* -------------------------------------------------------------------------------------
 * Per-SDK token extraction. Field names differ across all three providers, and between
 * chat and embedding endpoints within OpenAI.
 * ---------------------------------------------------------------------------------- */

type GeminiUsage = {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
};

export function tokensFromGemini(response: unknown): TokenCounts {
  const meta = (response as GeminiUsage | null)?.usageMetadata;
  if (!meta) return {};
  return {
    inputTokens: meta.promptTokenCount ?? null,
    outputTokens: meta.candidatesTokenCount ?? null,
    cachedInputTokens: meta.cachedContentTokenCount ?? null,
  };
}

type OpenAiUsage = {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

export function tokensFromOpenAi(response: unknown): TokenCounts {
  const usage = (response as OpenAiUsage | null)?.usage;
  if (!usage) return {};
  return {
    inputTokens: usage.prompt_tokens ?? null,
    // Embedding responses carry prompt_tokens only — no completion_tokens.
    outputTokens: usage.completion_tokens ?? null,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
  };
}

type AnthropicUsage = {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

export function tokensFromAnthropic(response: unknown): TokenCounts {
  const usage = (response as AnthropicUsage | null)?.usage;
  if (!usage) return {};
  return {
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    cachedInputTokens: usage.cache_read_input_tokens ?? null,
  };
}
