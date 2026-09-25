/**
 * Pins the provider registry. The trap this exists for: OpenRouter slugs are NOT Orbit's
 * model ids with a vendor prefix — Anthropic uses dots where Orbit uses dashes
 * (`anthropic/claude-haiku-4.5` against Orbit's `claude-haiku-4-5`), so the preset list is
 * literal and a mapping function would be a bug factory.
 */
import {
  AI_PROVIDERS,
  DEFAULT_MODELS,
  PROVIDER_MODELS,
  resolveAiProvider,
  type AiProvider,
} from "../src/lib/ai-providers";
import { EMBEDDING_MODELS, FAST_MODELS, VISION_MODELS } from "../src/lib/ai-models";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const PROVIDERS: AiProvider[] = ["gemini", "openai", "anthropic", "openrouter"];

check("openrouter resolves", resolveAiProvider("openrouter") === "openrouter");
check("unknown still falls back to gemini", resolveAiProvider("nope") === "gemini");
check("AI_PROVIDERS lists every provider", PROVIDERS.every((p) => AI_PROVIDERS.some((e) => e.id === p)));

for (const p of PROVIDERS) {
  check(`${p} default is in its preset list`, PROVIDER_MODELS[p].some((m) => m.value === DEFAULT_MODELS[p]));
  check(`${p} fast model is in its preset list`, PROVIDER_MODELS[p].some((m) => m.value === FAST_MODELS[p]));
}

// Every OpenRouter preset is a `vendor/model` slug. A bare id here means someone assumed
// the ids were interchangeable with the direct providers'.
check(
  "every openrouter preset is a vendor/model slug",
  PROVIDER_MODELS.openrouter.every((m) => /^[a-z0-9-]+\/[a-zA-Z0-9._-]+$/.test(m.value))
);
check("openrouter vision model is a slug", VISION_MODELS.openrouter.includes("/"));
check("openrouter embedding model is a slug", EMBEDDING_MODELS.openrouter.includes("/"));
check(
  "openrouter default matches the gemini default family",
  DEFAULT_MODELS.openrouter === "google/gemini-3.8-flash"
);
check(
  "openrouter embeds with the 1536-dim OpenAI model, so nothing is truncated",
  EMBEDDING_MODELS.openrouter === "openai/text-embedding-3-small"
);

console.log(failures === 0 ? "\nall ok" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
