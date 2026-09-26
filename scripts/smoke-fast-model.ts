/**
 * Verifies the fast-model map covers every provider with a known cheap model.
 * No DB, no network. Run: npx tsx scripts/smoke-fast-model.ts
 */
import { FAST_MODELS } from "../src/lib/ai";
import {
  AI_PROVIDERS,
  PROVIDER_MODELS,
  anthropicAcceptsTemperature,
  resolveAiModel,
} from "../src/lib/ai-providers";
import { priceFor } from "../src/lib/ai-pricing";
import { readFileSync } from "node:fs";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  for (const p of AI_PROVIDERS) {
    const fast = FAST_MODELS[p.id];
    check(`${p.id} has a fast model`, typeof fast === "string" && fast.length > 0);
    check(
      `${p.id} fast model is in the known roster`,
      PROVIDER_MODELS[p.id].some((m) => m.value === fast),
      fast
    );
  }

  // B8: `claude-opus-4` is not a model id, so every Anthropic user who picked it got
  // "That Anthropic model isn't available" on every feature.
  check("no preset is the invalid claude-opus-4", !PROVIDER_MODELS.anthropic.some((m) => m.value === "claude-opus-4"));
  check("the Opus preset is claude-opus-4-5", PROVIDER_MODELS.anthropic.some((m) => m.value === "claude-opus-4-5"));
  check("a stored claude-opus-4 migrates on read", resolveAiModel("anthropic", "claude-opus-4") === "claude-opus-4-5", resolveAiModel("anthropic", "claude-opus-4"));
  for (const p of AI_PROVIDERS) {
    // OpenRouter reports its own real cost (a later task adds `reportedCostMicros`); it is
    // deliberately absent from the static `ai-pricing.ts` table, which would otherwise be a
    // second, always-stale guess at what OpenRouter itself already tells Orbit precisely.
    if (p.id === "openrouter") continue;
    for (const m of PROVIDER_MODELS[p.id]) {
      check(`${m.value} has a price row`, priceFor(m.value) !== null);
    }
  }
  const opus = priceFor("claude-opus-4-5");
  check("claude-opus-4-5 prices at $5 / $25, not the Opus 4.0 row", opus?.input === 5 && opus?.output === 25, JSON.stringify(opus));

  check("sonnet 4.5 accepts temperature", anthropicAcceptsTemperature("claude-sonnet-4-5"));
  check("a dated sonnet 4.5 snapshot accepts it", anthropicAcceptsTemperature("claude-sonnet-4-5-20250929"));
  check("haiku 4.5 accepts it", anthropicAcceptsTemperature("claude-haiku-4-5"));
  check("opus 4.5 accepts it", anthropicAcceptsTemperature("claude-opus-4-5"));
  check("opus 4.7 does not", !anthropicAcceptsTemperature("claude-opus-4-7"));
  check("opus 5 does not", !anthropicAcceptsTemperature("claude-opus-5"));
  check("sonnet 5 does not", !anthropicAcceptsTemperature("claude-sonnet-5"));
  check("an unknown future id does not (omitting is always safe)", !anthropicAcceptsTemperature("claude-something-6"));

  const aiSource = readFileSync("src/lib/ai.ts", "utf8");
  check(
    "all three Anthropic calls gate temperature",
    (aiSource.match(/anthropicAcceptsTemperature\(model\)/g)?.length ?? 0) === 3
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
