import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { classifyAiError } from "@/lib/errors";
import { AI_PROVIDERS, type AiProvider } from "@/lib/ai-providers";

export type ProbeReason = "invalid" | "no_access" | "network" | "throttled";
export type ProbeResult =
  | { ok: true }
  | { ok: false; reason: ProbeReason; message: string };

/**
 * Maps a thrown provider-SDK error to a probe failure reason.
 *
 * Pure and provider/model-agnostic, so it's testable with synthetic errors and no network
 * (see scripts/smoke-ai-key-probe.ts). Reuses `classifyAiError`'s regex-based
 * classification so the probe's failure buckets stay in lockstep with the rest of the
 * app's AI-error handling instead of drifting apart.
 *
 * Never handles `rate_limit`: callers check that classification first — a 429 proves the
 * key authenticated, so it's treated as a successful probe rather than routed here.
 */
export function probeReasonFromError(
  err: unknown,
): Exclude<ProbeReason, "throttled"> {
  const kind = classifyAiError(err);
  if (kind === "auth") return "invalid";
  if (kind === "model_unavailable") return "no_access";
  // "timeout", "other" (e.g. ECONNREFUSED/DNS failures) and the unlikely
  // "empty_response" case all mean the same thing to a user verifying a key: we
  // couldn't get a clean answer from the provider.
  return "network";
}

function providerLabel(provider: AiProvider): string {
  return AI_PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
}

function probeFailureMessage(
  reason: Exclude<ProbeReason, "throttled">,
  provider: AiProvider,
  model: string,
): string {
  const label = providerLabel(provider);
  if (reason === "invalid") {
    return `That key was rejected by ${label}. Check you copied the whole thing.`;
  }
  if (reason === "no_access") {
    return `The key works, but it can't use ${model}. Pick another model under Advanced.`;
  }
  return `Couldn't reach ${label}. Try again in a moment.`;
}

/**
 * Verifies an API key against the provider with the cheapest authenticated call
 * available: a model-retrieve lookup, which returns model metadata and bills no tokens.
 *
 * - Gemini: `client.models.get({ model })` (@google/genai)
 * - OpenAI: `client.models.retrieve(model)` (openai)
 * - Anthropic: `client.models.retrieve(model)` (@anthropic-ai/sdk)
 *
 * A 429 still proves the key authenticated (Gemini's free tier rate-limits constantly),
 * so that's treated as success too. Never logs, echoes, or includes the key anywhere.
 */
export async function probeAiKey(
  provider: AiProvider,
  apiKey: string,
  model: string,
): Promise<ProbeResult> {
  try {
    if (provider === "gemini") {
      // `@google/genai`'s `GoogleGenAIOptions` has no top-level `timeout`/`maxRetries` like
      // the other two SDKs — the equivalent lives under `httpOptions` (`HttpOptions.timeout`,
      // in ms) and `httpOptions.retryOptions.attempts` (1 means no retries; the SDK defaults
      // to 5 attempts with up to a 60s backoff each, which could otherwise turn one slow
      // probe into minutes).
      const client = new GoogleGenAI({
        apiKey,
        httpOptions: { timeout: 15_000, retryOptions: { attempts: 1 } },
      });
      await client.models.get({ model });
    } else if (provider === "openai") {
      const client = new OpenAI({ apiKey, timeout: 15_000, maxRetries: 0 });
      await client.models.retrieve(model);
    } else {
      const client = new Anthropic({ apiKey, timeout: 15_000, maxRetries: 0 });
      await client.models.retrieve(model);
    }
    return { ok: true };
  } catch (err) {
    if (classifyAiError(err) === "rate_limit") return { ok: true };
    const reason = probeReasonFromError(err);
    return { ok: false, reason, message: probeFailureMessage(reason, provider, model) };
  }
}
