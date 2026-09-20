import type { AiProvider } from "@/lib/ai-providers";

/**
 * Provider list prices, USD per 1M tokens.
 *
 * Deliberately not in `ai-providers.ts` (client-importable — it should not carry a table
 * that goes stale) and not in `plan-copy.ts` (those are Orbit's prices; these are other
 * companies').
 *
 * Mostly these figures describe the *user's* spend — AI is BYOK on every plan but Lifetime.
 * They exist to spot a default model quietly burning someone's money, to ground a "you're a
 * heavy user, here's Lifetime" conversation, and — for Lifetime accounts on Orbit's managed
 * keys — to meter the monthly allowance, which is why every managed model must be priced.
 */
export type ModelPrice = {
  input: number;
  output: number;
  /** Discounted rate for cache-read input tokens, where the provider offers one. */
  cachedInput?: number;
  /**
   * Rate for audio input tokens, where the provider bills audio differently from text
   * (Gemini does, and by a lot: 2.5 Flash is $0.30 text but $1.00 audio). Absent = the
   * provider lists one input price for every modality, so audio bills at `input`.
   */
  audioInput?: number;
};

type PriceEntry = ModelPrice & {
  /**
   * A price change the provider has ALREADY ANNOUNCED, effective from `from` (UTC midnight).
   * Without it the table goes silently wrong on a known date — Gemini 3.8 Flash doubles on
   * Jan 1 2027 — and every row written after that would be priced at the old rate.
   */
  scheduled?: { from: string; price: ModelPrice };
};

/**
 * Checked against each provider's published pricing page on Sep 19 2026. Re-check before
 * changing a default model: these rows are what make a model look cheap or expensive to
 * the code that picks one, and the managed allowance is metered against them.
 *
 * The Sep 2026 correction is worth remembering: this table had Gemini 3.5 Flash at
 * $0.30/$2.50 while Google charged $1.50/$9.00, so every Gemini figure in Settings and every
 * managed-allowance read was 4–5× too low.
 */
const PRICES: Record<string, PriceEntry> = {
  // Google
  "gemini-3.8-flash": {
    input: 0.75,
    output: 3.75,
    cachedInput: 0.075,
    scheduled: { from: "2027-01-01", price: { input: 1.5, output: 7.5, cachedInput: 0.15 } },
  },
  "gemini-3.5-flash": { input: 1.5, output: 9, cachedInput: 0.15 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cachedInput: 0.03 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cachedInput: 0.025, audioInput: 0.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cachedInput: 0.125 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cachedInput: 0.03, audioInput: 1 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cachedInput: 0.01, audioInput: 0.3 },
  // Gone from Google's pricing page (it lists gemini-embedding-2 now), but still served until
  // its May 14 2028 shutdown, and still the model `ai.ts` embeds with.
  "gemini-embedding-001": { input: 0.15, output: 0 },
  "gemini-embedding-2": { input: 0.2, output: 0 },

  // OpenAI. No bare "gpt-5" row on purpose: longest-prefix matching would then price every
  // unlisted gpt-5.x id (gpt-5.6-sol is $4 in) at the $1.25 base model's rate.
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cachedInput: 0.02 },
  "gpt-5-mini": { input: 0.25, output: 2, cachedInput: 0.025 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cachedInput: 0.005 },
  "gpt-4o": { input: 2.5, output: 10, cachedInput: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
  "gpt-4.1": { input: 2, output: 8, cachedInput: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cachedInput: 0.1 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cachedInput: 0.025 },
  "text-embedding-3-small": { input: 0.02, output: 0 },

  // Anthropic. Claude 4.7 and later use a tokenizer that yields ~30% more tokens for the
  // same text, so compare models on measured tokens, never on these rates alone.
  "claude-sonnet-5": { input: 2, output: 10, cachedInput: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cachedInput: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cachedInput: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1 },
  "claude-opus-4-8": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cachedInput: 0.5 },
  // Opus 4.0 / 4.1 (both retired), reachable only as a stored or typed custom id; keeps
  // historical usage rows priced. Longest-prefix matching keeps every claude-opus-4-N row
  // above on its own price.
  "claude-opus-4": { input: 15, output: 75, cachedInput: 1.5 },
};

/**
 * Anthropic bills a 5-minute cache WRITE at 1.25× the input rate, and is the only provider
 * that reports write tokens separately. Every provider's Batch API bills at half price.
 */
const CACHE_WRITE_MULTIPLIER = 1.25;
const BATCH_MULTIPLIER = 0.5;

/**
 * Exact id first, then longest matching prefix so dated snapshots resolve
 * (`gemini-3.5-flash-002` → `gemini-3.5-flash`). `at` switches to an announced price once
 * its date has passed.
 *
 * Returns null rather than guessing. A blank cell in the admin UI is honest; a
 * confidently wrong dollar figure is worse than no figure, and it would get summed.
 */
export function priceFor(model: string, at: Date = new Date()): ModelPrice | null {
  let entry: PriceEntry | undefined = PRICES[model];
  if (!entry) {
    let best: { key: string; price: PriceEntry } | null = null;
    for (const [key, price] of Object.entries(PRICES)) {
      if (!model.startsWith(key)) continue;
      if (!best || key.length > best.key.length) best = { key, price };
    }
    entry = best?.price;
  }
  if (!entry) return null;

  const { scheduled, ...current } = entry;
  if (scheduled && at.getTime() >= Date.parse(`${scheduled.from}T00:00:00Z`)) {
    return scheduled.price;
  }
  return current;
}

/**
 * Estimated cost in micro-dollars (USD × 1e6), or null when the model is unpriced or the
 * provider reported no token counts.
 *
 * Integers because floats accumulate error across SUM, and Postgres `numeric` comes back
 * as a string anyway. Computed at write time and stored on the row, so the estimate
 * reflects prices as they were — repricing history is not a goal.
 *
 * `inputTokens` is the WHOLE prompt; `cachedInputTokens`, `cacheWriteTokens` and
 * `audioInputTokens` are parts of it that bill at their own rates. The extractors in
 * `usage-events.ts` normalise every provider to that shape — Anthropic's raw `input_tokens`
 * leaves cache reads and writes out, so it is summed there, not here.
 */
export function estimateCostMicros(input: {
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteTokens?: number | null;
  audioInputTokens?: number | null;
  /** Sent through a provider Batch API, which bills at half price. */
  batch?: boolean;
  /** When the call was made, for announced price changes. Defaults to now. */
  at?: Date;
}): number | null {
  const price = priceFor(input.model, input.at);
  if (!price) return null;

  const inTok = input.inputTokens ?? 0;
  const outTok = input.outputTokens ?? 0;
  const cachedTok = input.cachedInputTokens ?? 0;
  const writeTok = input.cacheWriteTokens ?? 0;
  const audioTok = input.audioInputTokens ?? 0;
  if (inTok === 0 && outTok === 0 && cachedTok === 0) return null;

  // Each part of the prompt bills at its own rate; whatever is left is plain input.
  const plain = Math.max(0, inTok - cachedTok - writeTok - audioTok);
  const cachedRate = price.cachedInput ?? price.input;
  const audioRate = price.audioInput ?? price.input;

  const usd =
    (plain * price.input +
      cachedTok * cachedRate +
      writeTok * price.input * CACHE_WRITE_MULTIPLIER +
      audioTok * audioRate +
      outTok * price.output) /
    1_000_000;

  return Math.round(usd * (input.batch ? BATCH_MULTIPLIER : 1) * 1_000_000);
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
