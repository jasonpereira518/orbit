export type AiProvider = "gemini" | "openai" | "anthropic";
export type EmbeddingBackend = "gemini" | "openai";

export const AI_PROVIDERS: Array<{
  id: AiProvider;
  label: string;
  keyPlaceholder: string;
  envVar: string;
  /** Where a person creates a key — onboarding and Settings link straight to it. */
  keyPageUrl: string;
  /** The link's text: names the console, since "Get a key" reads as Orbit selling one. */
  keyPageLabel: string;
}> = [
  {
    id: "gemini",
    label: "Google Gemini",
    keyPlaceholder: "AIza...",
    envVar: "GEMINI_API_KEY",
    keyPageUrl: "https://aistudio.google.com/app/apikey",
    keyPageLabel: "Create a key in Google AI Studio",
  },
  {
    id: "openai",
    label: "OpenAI",
    keyPlaceholder: "sk-...",
    envVar: "OPENAI_API_KEY",
    keyPageUrl: "https://platform.openai.com/api-keys",
    keyPageLabel: "Create a key on OpenAI’s platform",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    keyPlaceholder: "sk-ant-...",
    envVar: "ANTHROPIC_API_KEY",
    keyPageUrl: "https://console.anthropic.com/settings/keys",
    keyPageLabel: "Create a key in the Anthropic console",
  },
];

export const PROVIDER_MODELS: Record<
  AiProvider,
  Array<{ value: string; label: string }>
> = {
  gemini: [
    { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite (cheapest)" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
  openai: [
    { value: "gpt-4o-mini", label: "GPT-4o mini (cheapest)" },
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "gpt-4.1-mini", label: "GPT-4.1 mini" },
    { value: "gpt-4.1", label: "GPT-4.1" },
  ],
  anthropic: [
    { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5 (cheapest)" },
    { value: "claude-opus-4-5", label: "Claude Opus 4.5" },
  ],
};

/**
 * What a new account gets, and what an account that never chose keeps.
 *
 * Gemini's default moved from 3.5 Flash to 3.8 Flash on Sep 19 2026: newer, and half the
 * price per token ($0.75/$3.75 against $1.50/$9.00 — and still cheaper on output after
 * Google's announced Jan 2027 increase). The eval in docs/ai-evals/ measured no accuracy
 * lost on capture, OCR or chat.
 */
export const DEFAULT_MODELS: Record<AiProvider, string> = {
  gemini: "gemini-3.8-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5",
};

/**
 * Stored ids that resolve to something else on read.
 *
 * The 2.5 entries are not cosmetic: Google answers 404 "no longer available to new users"
 * for those models on a key issued since, so a stored 2.5 id is a broken account until it
 * is remapped. They point at the cheapest current model of the same shape.
 */
const LEGACY_MODEL_MAP: Record<string, string> = {
  "gemini-2.5-flash": "gemini-3.8-flash",
  "gemini-2.5-flash-lite": "gemini-3.1-flash-lite",
  // Was offered as a preset but was never a valid Anthropic id (the 4.0 alias was
  // claude-opus-4-0, and that snapshot retired June 15 2026). Stored settings migrate on read.
  "claude-opus-4": "claude-opus-4-5",
};

/**
 * Anthropic model families that still accept `temperature`.
 *
 * An ALLOWLIST on purpose: Claude 4.7 and later (Opus 4.7, 4.8, 5, Sonnet 5, Fable) return
 * a 400 for a non-default sampling parameter, and a custom id typed into Settings is newer
 * than any list. Omitting temperature is accepted by every model, so an unknown id falls
 * safe. Only families still served are listed — Opus 4.0/4.1, Sonnet 4.0 and Claude 3 are
 * retired, and a request to them fails whatever it carries.
 */
const ANTHROPIC_TEMPERATURE_FAMILIES = [
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-opus-4-6",
];

export function anthropicAcceptsTemperature(model: string): boolean {
  return ANTHROPIC_TEMPERATURE_FAMILIES.some(
    (family) => model === family || model.startsWith(`${family}-`)
  );
}

export function resolveAiProvider(value?: string | null): AiProvider {
  if (value === "openai" || value === "anthropic" || value === "gemini") {
    return value;
  }
  return "gemini";
}

function modelBelongsToProvider(provider: AiProvider, model: string) {
  const known = PROVIDER_MODELS[provider].some((m) => m.value === model);
  if (known) return true;
  if (provider === "gemini") return model.startsWith("gemini-");
  if (provider === "openai") {
    return model.startsWith("gpt-") || model.startsWith("o");
  }
  if (provider === "anthropic") return model.startsWith("claude-");
  return false;
}

export function resolveAiModel(
  provider: AiProvider,
  model?: string | null
): string {
  const requested = model?.trim() || "";
  const remapped = LEGACY_MODEL_MAP[requested] || requested;
  if (remapped && modelBelongsToProvider(provider, remapped)) {
    return remapped;
  }
  return DEFAULT_MODELS[provider];
}
