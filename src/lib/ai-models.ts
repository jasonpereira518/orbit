import type { AiProvider, EmbeddingBackend } from "@/lib/ai-providers";
import { aiOperationTier, type AiOperationId } from "@/lib/ai-operations";
import { managedModel } from "@/lib/managed-ai-policy";
import { priceFor } from "@/lib/ai-pricing";

/**
 * Which model each operation runs on.
 *
 * The tier lives in the operation registry (`ai-operations.ts`) and the models live here, so
 * "what does capture parsing run on" is answered in one place rather than by an argument at
 * a call site. `ai.ts` and the batch submitter both resolve through `modelForOperation`.
 */

/**
 * Cheapest usable model per provider, for calls where the user's configured model would be
 * overkill: classification, ranking, extraction nobody reads directly.
 * Values must exist in PROVIDER_MODELS (smoke-fast-model.ts enforces this).
 */
export const FAST_MODELS: Record<AiProvider, string> = {
  gemini: "gemini-3.1-flash-lite",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
  openrouter: "google/gemini-3.1-flash-lite",
};

/**
 * What reads a photograph, regardless of what the user picked for chat.
 *
 * Deliberately NOT `FAST_MODELS`. OCR sits at the root of the capture pipeline: every
 * contact, every dedupe decision and every reminder downstream inherits whatever it got
 * wrong, and because the photo is processed ephemerally and never stored, a misread name
 * cannot be recovered later — there is nothing left to re-read. The lite tiers save a
 * fraction of a cent per page and give up exactly the thing that matters most here, which
 * is dense handwriting. Speed comes from transcribing pages concurrently
 * (`capture-ingest.ts`) and from shrinking them before upload (`scan-image.ts`), never
 * from a weaker pair of eyes.
 *
 * Gemini's entry moved to 3.8 Flash on Sep 19 2026 — half the price of 3.5 Flash, and the
 * eval read every fixture page with no character errors and no missed names.
 */
export const VISION_MODELS: Record<AiProvider, string> = {
  gemini: "gemini-3.8-flash",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-5",
  openrouter: "google/gemini-3.8-flash",
};

export const EMBEDDING_MODELS: Record<EmbeddingBackend, string> = {
  gemini: "gemini-embedding-001",
  openai: "text-embedding-3-small",
  // The 1536-dim OpenAI model, so nothing OpenRouter embeds is truncated against what the
  // direct OpenAI backend already stores.
  openrouter: "openai/text-embedding-3-small",
};

/**
 * TypeSafe's decision model, pinned to a version rather than `jev-latest`. Every threshold in
 * `src/lib/decisions/catalog.ts` was tuned against this version's probabilities; a new one
 * can shift them, so moving this means re-running `scripts/eval-ai.ts --decisions jev` and
 * re-reading the calibration bins before anything ships.
 */
export const JEV_MODEL = "jev-1.13.0";

/**
 * A rough price for comparing two models: a prompt is mostly input, and an answer is a few
 * hundred tokens, so input is weighted accordingly. Null when either model is unpriced —
 * an unknown model is never assumed cheap.
 */
function relativeCost(model: string): number | null {
  const price = priceFor(model);
  if (!price) return null;
  return price.input * 3 + price.output;
}

/**
 * The model this operation runs on, given the grant it will run under.
 *
 * Two rules beyond the tier itself:
 *  - A person whose own model is already cheaper than the tier's keeps theirs. Someone who
 *    picked Flash-Lite for everything should not be "upgraded" onto a dearer model by a
 *    tier that exists to save money.
 *  - On Orbit's managed key every tier resolves through `managedModel`, so a tier cannot
 *    reach past the managed allowlist (vision used to, and gpt-4o is 16× gpt-4o-mini).
 */
export function modelForOperation(
  operation: AiOperationId,
  grant: { provider: AiProvider; model: string; keyOwner: "user" | "orbit" }
): string {
  const tier = aiOperationTier(operation);
  const tierModel = tier === "fast" ? FAST_MODELS[grant.provider] : tier === "vision" ? VISION_MODELS[grant.provider] : null;
  if (!tierModel) return grant.model;

  const own = relativeCost(grant.model);
  const tiered = relativeCost(tierModel);
  const chosen = own !== null && tiered !== null && own <= tiered ? grant.model : tierModel;
  return grant.keyOwner === "orbit" ? managedModel(grant.provider, chosen) : chosen;
}
