/**
 * Per-provider request parameters that depend on the MODEL, kept out of `ai.ts`'s five
 * inline dispatch branches so the rules live in one place a smoke test can pin
 * (`scripts/smoke-ai-request-options.ts`). Pure: no SDKs, no env, no DB.
 *
 * Thinking is the lever here. Gemini 3.x thinks by default (3.5 Flash at "medium"), and a
 * thinking token bills at the output rate — $9 per million on 3.5 Flash — while an
 * extraction call's visible answer is a few hundred tokens. It also spends
 * `maxOutputTokens`, so a tight cap truncates the answer instead of the thought.
 */

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

const LEVEL_ORDER: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high"];

/**
 * Levels each Gemini model accepts, from Google's thinking guide (Sep 19 2026). A model not
 * listed gets no thinking parameter at all — its provider default — because an unsupported
 * level is a failed call. Matched by longest prefix, so dated snapshots resolve.
 */
const GEMINI_THINKING_LEVELS: Record<string, readonly ThinkingLevel[]> = {
  "gemini-3.8-flash": ["low", "medium", "high"],
  "gemini-3.7-flash": ["low", "medium", "high"],
  "gemini-3.6-flash": ["minimal", "low", "medium", "high"],
  "gemini-3.5-flash": ["minimal", "low", "medium", "high"],
  "gemini-3.5-flash-lite": ["minimal", "low", "medium", "high"],
  "gemini-3.1-pro": ["low", "medium", "high"],
};

function longestPrefix<T>(table: Record<string, T>, model: string): T | undefined {
  let best: string | null = null;
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? table[best] : undefined;
}

/**
 * The Gemini `thinkingConfig` for a requested level, or undefined to leave the model on its
 * default. A level the model does not offer rounds UP to the nearest one it does ("minimal"
 * on 3.8 Flash becomes "low"): asking for less thinking than exists must not fail the call,
 * and rounding down would silently think less than was asked.
 */
export function geminiThinkingConfig(
  model: string,
  level: ThinkingLevel | undefined
): { thinkingLevel: string } | undefined {
  if (!level) return undefined;
  const supported = longestPrefix(GEMINI_THINKING_LEVELS, model);
  if (!supported?.length) return undefined;
  const wanted = LEVEL_ORDER.indexOf(level);
  const pick = LEVEL_ORDER.slice(wanted).find((l) => supported.includes(l));
  // The SDK's enum values are the upper-case names ("LOW"); ai.ts imports it type-only.
  return pick ? { thinkingLevel: pick.toUpperCase() } : undefined;
}

/**
 * OpenAI's reasoning families. They reject `temperature` and `max_tokens` (a custom id like
 * `gpt-5-mini` typed into Settings used to fail every call with a 400) and take
 * `max_completion_tokens` and `reasoning_effort` instead.
 */
export function isOpenAiReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model);
}

/**
 * Request fields for an OpenAI chat completion, by model: sampling and length parameters
 * where the family takes them, and reasoning effort where it has one. The lowest effort
 * differs by family: gpt-5.1 and later take "none" (and not "minimal"), the original gpt-5
 * family takes "minimal", and the o-series starts at "low".
 */
export function openaiCompletionOptions(
  model: string,
  opts: { temperature: number; maxOutputTokens: number; thinking?: ThinkingLevel }
):
  | { temperature: number; max_tokens: number }
  | { max_completion_tokens: number; reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" } {
  if (!isOpenAiReasoningModel(model)) {
    return { temperature: opts.temperature, max_tokens: opts.maxOutputTokens };
  }
  if (!opts.thinking) return { max_completion_tokens: opts.maxOutputTokens };
  let effort: "none" | "minimal" | "low" | "medium" | "high" = opts.thinking;
  if (opts.thinking === "minimal") {
    if (/^gpt-5\.\d/.test(model)) effort = "none";
    else if (/^o\d/.test(model)) effort = "low";
  }
  return { max_completion_tokens: opts.maxOutputTokens, reasoning_effort: effort };
}
