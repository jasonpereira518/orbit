/**
 * Pins the provider registry. The trap this exists for: OpenRouter slugs are NOT Orbit's
 * model ids with a vendor prefix — Anthropic uses dots where Orbit uses dashes
 * (`anthropic/claude-haiku-4.5` against Orbit's `claude-haiku-4-5`), so the preset list is
 * literal and a mapping function would be a bug factory.
 */
import { readFileSync } from "node:fs";
import {
  AI_PROVIDERS,
  SELECTABLE_AI_PROVIDERS,
  isSelectableAiProvider,
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

/**
 * The user-facing list, pinned exactly.
 *
 * `AI_PROVIDERS` is a UI registry, not just a data table: the Settings provider `<Select>`
 * and the onboarding provider tiles both render straight off a list derived from it, so
 * adding the OpenRouter entry shipped a selectable "OpenRouter" option — with an
 * `sk-or-v1-…` paste field — into Settings AND into onboarding with no change to either
 * file. OpenRouter's plumbing is deliberately code-only. The AI page is being redesigned
 * around these three; this check is what stops that pass reintroducing a fourth by
 * accident.
 */
const SELECTABLE_IDS = SELECTABLE_AI_PROVIDERS.map((p) => p.id);
check(
  "the user-selectable provider list is exactly gemini, openai, anthropic",
  JSON.stringify(SELECTABLE_IDS) === JSON.stringify(["gemini", "openai", "anthropic"])
);
check("openrouter is not selectable", !isSelectableAiProvider("openrouter"));
check(
  "every selectable provider is a real AI_PROVIDERS entry",
  SELECTABLE_IDS.every((id) => AI_PROVIDERS.some((e) => e.id === id))
);
check(
  "openrouter still HAS an entry — Record<AiProvider, …> exhaustiveness and the key-check registry need it",
  AI_PROVIDERS.some((e) => e.id === "openrouter")
);

// The registry is only as good as the call sites. Every surface a person picks a provider
// from must map over the selectable list; a bare `AI_PROVIDERS.map` in one of these files
// is the exact regression above.
for (const file of [
  "src/components/settings/ai-settings.tsx",
  "src/components/onboarding/wizard/wizard-ai-key.tsx",
]) {
  const source = readFileSync(file, "utf8");
  check(`${file} does not map over AI_PROVIDERS`, !/\bAI_PROVIDERS\s*\.\s*map\b/.test(source));
  check(`${file} renders from SELECTABLE_AI_PROVIDERS`, source.includes("SELECTABLE_AI_PROVIDERS"));
}

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
