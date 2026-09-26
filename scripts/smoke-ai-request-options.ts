/**
 * Pins the model-dependent request rules in `src/lib/ai-request-options.ts`: which thinking
 * level each Gemini model is sent (and that an unknown model is sent none), and which
 * OpenAI families take sampling parameters versus reasoning effort.
 *
 * No DB, no network. Run: npx tsx scripts/smoke-ai-request-options.ts
 */
import {
  geminiThinkingConfig,
  isOpenAiReasoningModel,
  openaiCompletionOptions,
} from "../src/lib/ai-request-options";
import { anthropicAcceptsTemperature } from "../src/lib/ai-providers";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const level = (model: string, l: Parameters<typeof geminiThinkingConfig>[1]) =>
  geminiThinkingConfig(model, l)?.thinkingLevel;

console.log("Gemini thinking");
check("no level asked → nothing sent (provider default)", geminiThinkingConfig("gemini-3.5-flash", undefined) === undefined);
check("3.5 Flash takes minimal", level("gemini-3.5-flash", "minimal") === "MINIMAL");
check("3.5 Flash takes low", level("gemini-3.5-flash", "low") === "LOW");
check("a dated snapshot resolves to its family", level("gemini-3.5-flash-002", "low") === "LOW");
check("3.8 Flash has no minimal: rounds UP to low", level("gemini-3.8-flash", "minimal") === "LOW");
check("3.5 Flash-Lite is not mistaken for 3.5 Flash", level("gemini-3.5-flash-lite", "minimal") === "MINIMAL");
check("an unlisted model is sent nothing rather than a level it may reject", geminiThinkingConfig("gemini-2.5-flash", "low") === undefined);
check("an unknown future id is sent nothing", geminiThinkingConfig("gemini-9-ultra", "low") === undefined);

console.log("\nOpenAI families");
check("gpt-4o-mini is not a reasoning model", !isOpenAiReasoningModel("gpt-4o-mini"));
check("gpt-4.1 is not", !isOpenAiReasoningModel("gpt-4.1"));
check("gpt-5-mini is", isOpenAiReasoningModel("gpt-5-mini"));
check("gpt-5.6-luna is", isOpenAiReasoningModel("gpt-5.6-luna"));
check("o4-mini is", isOpenAiReasoningModel("o4-mini"));

const classic = openaiCompletionOptions("gpt-4o-mini", { temperature: 0.2, maxOutputTokens: 500, thinking: "low" });
check("a classic model keeps temperature and max_tokens", "temperature" in classic && "max_tokens" in classic && !("reasoning_effort" in classic));
const reasoning = openaiCompletionOptions("gpt-5-mini", { temperature: 0.2, maxOutputTokens: 500 });
check(
  "a reasoning model gets max_completion_tokens and no temperature (it 400s on one)",
  "max_completion_tokens" in reasoning && !("temperature" in reasoning) && !("reasoning_effort" in reasoning)
);
const effort = (model: string, thinking: "minimal" | "low") =>
  (openaiCompletionOptions(model, { temperature: 0, maxOutputTokens: 1, thinking }) as { reasoning_effort?: string }).reasoning_effort;
check("gpt-5.6 minimal → none", effort("gpt-5.6-luna", "minimal") === "none");
check("gpt-5 minimal stays minimal", effort("gpt-5-mini", "minimal") === "minimal");
check("o-series minimal → low", effort("o4-mini", "minimal") === "low");
check("low is low everywhere", effort("gpt-5.6-luna", "low") === "low" && effort("o4-mini", "low") === "low");

/**
 * OpenRouter presets are `vendor/model` slugs, and every family rule above is anchored. A
 * slug that answered differently from its bare id is a 400 on every call: the GPT-5 family
 * rejects `temperature`/`max_tokens`, and Claude 4.7+ rejects sampling parameters too, so
 * `openai/gpt-5.4-mini` and `anthropic/claude-sonnet-5` both used to be broken presets.
 * Each family is asserted in BOTH forms so the two cannot drift apart again.
 */
console.log("\nOpenRouter vendor/model slugs");
check("openai/gpt-5.4-mini is a reasoning model, same as its bare id", isOpenAiReasoningModel("openai/gpt-5.4-mini") && isOpenAiReasoningModel("gpt-5.4-mini"));
check("openai/o4-mini is too", isOpenAiReasoningModel("openai/o4-mini") && isOpenAiReasoningModel("o4-mini"));
check("openai/gpt-4o-mini still is not", !isOpenAiReasoningModel("openai/gpt-4o-mini") && !isOpenAiReasoningModel("gpt-4o-mini"));
check("a non-OpenAI slug is not (google/gemini-3.8-flash)", !isOpenAiReasoningModel("google/gemini-3.8-flash"));

const slugReasoning = openaiCompletionOptions("openai/gpt-5.4-mini", { temperature: 0.2, maxOutputTokens: 500 });
check(
  "openai/gpt-5.4-mini gets max_completion_tokens and no temperature",
  "max_completion_tokens" in slugReasoning && !("temperature" in slugReasoning)
);
check("a slug's reasoning effort resolves like the bare id: gpt-5.4 minimal → none", effort("openai/gpt-5.4-mini", "minimal") === "none" && effort("gpt-5.4-mini", "minimal") === "none");
check("o-series slug minimal → low", effort("openai/o4-mini", "minimal") === "low");

const slugSonnet5 = openaiCompletionOptions("anthropic/claude-sonnet-5", { temperature: 0.2, maxOutputTokens: 500 });
check(
  "anthropic/claude-sonnet-5 over OpenRouter sends no temperature (Claude 4.7+ 400s on one)",
  !("temperature" in slugSonnet5) && "max_tokens" in slugSonnet5
);
check(
  "...and the bare id agrees",
  !anthropicAcceptsTemperature("claude-sonnet-5") && !anthropicAcceptsTemperature("anthropic/claude-sonnet-5")
);
const slugHaiku = openaiCompletionOptions("anthropic/claude-haiku-4.5", { temperature: 0.2, maxOutputTokens: 500 });
check(
  "anthropic/claude-haiku-4.5 keeps temperature — OpenRouter writes the version with a dot, Orbit with a dash",
  "temperature" in slugHaiku && "max_tokens" in slugHaiku
);
check(
  "...and the bare id agrees",
  anthropicAcceptsTemperature("claude-haiku-4-5") && anthropicAcceptsTemperature("anthropic/claude-haiku-4.5")
);
const slugGemini = openaiCompletionOptions("google/gemini-3.8-flash", { temperature: 0.2, maxOutputTokens: 500 });
check(
  "a Gemini slug still takes sampling parameters",
  "temperature" in slugGemini && "max_tokens" in slugGemini
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll request-option checks passed.");
process.exit(0);
