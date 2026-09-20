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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll request-option checks passed.");
process.exit(0);
