import type { AiProvider } from "@/lib/ai-providers";

/**
 * Provider list prices, USD per 1M tokens.
 *
 * Deliberately not in `ai-providers.ts` (client-importable — it should not carry a table
 * that goes stale) and not in `plan-copy.ts` (those are Orbit's prices; these are other
 * companies').
 *
 * Production is strictly BYOK, so these figures almost always describe the *user's* spend,
 * not Orbit's. They exist to spot a default model quietly burning someone's money, and to
 * ground a "you're a heavy user, here's Lifetime" conversation — not as a P&L line.
 */
export type ModelPrice = {
  input: number;
  output: number;
  /** Discounted rate for cache-read input tokens, where the provider offers one. */
  cachedInput?: number;
};

const PRICES: Record<string, ModelPrice> = {
  // Google
  "gemini-3.5-flash": { input: 0.3, output: 2.5, cachedInput: 0.075 },
  "gemini-3.1-flash-lite": { input: 0.1, output: 0.4, cachedInput: 0.025 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cachedInput: 0.31 },
  "gemini-embedding-001": { input: 0.15, output: 0 },

  // OpenAI
  "gpt-4o": { input: 2.5, output: 10, cachedInput: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
  "gpt-4.1": { input: 2, output: 8, cachedInput: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cachedInput: 0.1 },
  "text-embedding-3-small": { input: 0.02, output: 0 },

  // Anthropic
  "claude-sonnet-4-5": { input: 3, output: 15, cachedInput: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1 },
  "claude-opus-4": { input: 15, output: 75, cachedInput: 1.5 },
};

/**
 * Exact id first, then longest matching prefix so dated snapshots resolve
 * (`gemini-3.5-flash-002` → `gemini-3.5-flash`).
 *
 * Returns null rather than guessing. A blank cell in the admin UI is honest; a
 * confidently wrong dollar figure is worse than no figure, and it would get summed.
 */
export function priceFor(model: string): ModelPrice | null {
  const exact = PRICES[model];
  if (exact) return exact;

  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(PRICES)) {
    if (!model.startsWith(key)) continue;
    if (!best || key.length > best.key.length) best = { key, price };
  }
  return best?.price ?? null;
}

/**
 * Estimated cost in micro-dollars (USD × 1e6), or null when the model is unpriced or the
 * provider reported no token counts.
 *
 * Integers because floats accumulate error across SUM, and Postgres `numeric` comes back
 * as a string anyway. Computed at write time and stored on the row, so the estimate
 * reflects prices as they were — repricing history is not a goal.
 */
export function estimateCostMicros(input: {
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
}): number | null {
  const price = priceFor(input.model);
  if (!price) return null;

  const inTok = input.inputTokens ?? 0;
  const outTok = input.outputTokens ?? 0;
  const cachedTok = input.cachedInputTokens ?? 0;
  if (inTok === 0 && outTok === 0 && cachedTok === 0) return null;

  // Providers report cached tokens as a subset of the input count, so bill the remainder
  // at full rate and the cached portion at the discounted rate when one exists.
  const uncached = Math.max(0, inTok - cachedTok);
  const cachedRate = price.cachedInput ?? price.input;

  const usd =
    (uncached * price.input +
      cachedTok * cachedRate +
      outTok * price.output) /
    1_000_000;

  return Math.round(usd * 1_000_000);
}

/** Human-readable dollars for the admin UI. Null in, null out — never a fake $0.00. */
export function formatCostMicros(micros: number | null | undefined): string | null {
  if (micros == null) return null;
  const usd = micros / 1_000_000;
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export type { AiProvider };
