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
  LEGACY_MODEL_MAP,
  resolveAiProvider,
  tieredModels,
  type AiProvider,
} from "../src/lib/ai-providers";
import { EMBEDDING_MODELS, FAST_MODELS, VISION_MODELS } from "../src/lib/ai-models";
import { priceFor } from "../src/lib/ai-pricing";

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

// Not every provider gets three tiers: a provider gets a `best` only when there is a model
// worth putting there (round 1 review — Gemini's 3.5 Flash costs 2x 3.8 Flash for measurably
// worse results per docs/ai-evals/2026-09-19-gemini-*, so Gemini stops at `balanced`). At
// most one of each tier, and cheapest + balanced are mandatory; the AI page renders however
// many tiers a provider declares.
for (const p of SELECTABLE_AI_PROVIDERS) {
  const tiers = PROVIDER_MODELS[p.id].filter((m) => m.tier);
  const tierValues = tiers.map((m) => m.tier);
  check(`${p.id} tags at most one of each tier`, new Set(tierValues).size === tierValues.length);
  check(
    `${p.id} tags at least cheapest and balanced`,
    tierValues.includes("cheapest") && tierValues.includes("balanced")
  );
  const balanced = PROVIDER_MODELS[p.id].find((m) => m.tier === "balanced");
  check(
    `${p.id}'s default is its balanced tier`,
    balanced !== undefined && DEFAULT_MODELS[p.id] === balanced.value
  );
}
check(
  "no tier points at a Gemini 2.5 model — Google 404s those for keys issued since",
  !PROVIDER_MODELS.gemini.some((m) => m.tier && m.value.startsWith("gemini-2.5"))
);
check(
  "Gemini has no `best` tier — 3.5 Flash is not it (worse AND pricier than 3.8 per the recorded evals)",
  !PROVIDER_MODELS.gemini.some((m) => m.tier === "best")
);
check(
  "tieredModels returns declared tiers in cheapest, balanced, best order",
  tieredModels("gemini").map((m) => m.tier).join(",") === "cheapest,balanced" &&
    tieredModels("anthropic").map((m) => m.tier).join(",") === "cheapest,balanced,best"
);

// The one check that ties a tier LABEL to a FACT rather than trusting the tag: a provider's
// declared tiers must get strictly (well, non-strictly) more expensive as they go up, on both
// input and output price. Every other check here passes happily on an inverted ladder — this
// is the one round 1 asked for after finding Gemini's `best` was priced above `balanced` while
// scoring worse.
for (const p of SELECTABLE_AI_PROVIDERS) {
  const tiers = tieredModels(p.id);
  for (let i = 1; i < tiers.length; i++) {
    const prev = priceFor(tiers[i - 1].value);
    const curr = priceFor(tiers[i].value);
    check(
      `${p.id}: ${tiers[i - 1].tier} → ${tiers[i].tier} does not get cheaper (input)`,
      prev !== null && curr !== null && curr.input >= prev.input
    );
    check(
      `${p.id}: ${tiers[i - 1].tier} → ${tiers[i].tier} does not get cheaper (output)`,
      prev !== null && curr !== null && curr.output >= prev.output
    );
  }
}

// A preset dropped from PROVIDER_MODELS (because it 404s, or was never valid) must not
// become unreachable to an account still stored on it — LEGACY_MODEL_MAP is how those
// accounts land somewhere that works. And a map target has to actually be one of today's
// live presets, or the migration just trades one broken id for another.
for (const deadId of ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "claude-opus-4"]) {
  check(`${deadId} (removed from PROVIDER_MODELS) has a LEGACY_MODEL_MAP entry`, deadId in LEGACY_MODEL_MAP);
}
check(
  "every LEGACY_MODEL_MAP target is a live preset somewhere in PROVIDER_MODELS",
  Object.values(LEGACY_MODEL_MAP).every((target) =>
    Object.values(PROVIDER_MODELS).some((list) => list.some((m) => m.value === target))
  )
);

console.log(failures === 0 ? "\nall ok" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
