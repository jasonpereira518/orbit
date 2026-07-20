export type AiProvider = "gemini" | "openai" | "anthropic";
export type EmbeddingBackend = "gemini" | "openai";

export const AI_PROVIDERS: Array<{
  id: AiProvider;
  label: string;
  keyPlaceholder: string;
  envVar: string;
}> = [
  {
    id: "gemini",
    label: "Google Gemini",
    keyPlaceholder: "AIza...",
    envVar: "GEMINI_API_KEY",
  },
  {
    id: "openai",
    label: "OpenAI",
    keyPlaceholder: "sk-...",
    envVar: "OPENAI_API_KEY",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    keyPlaceholder: "sk-ant-...",
    envVar: "ANTHROPIC_API_KEY",
  },
];

export const PROVIDER_MODELS: Record<
  AiProvider,
  Array<{ value: string; label: string }>
> = {
  gemini: [
    { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
  openai: [
    { value: "gpt-4o-mini", label: "GPT-4o mini" },
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "gpt-4.1-mini", label: "GPT-4.1 mini" },
    { value: "gpt-4.1", label: "GPT-4.1" },
  ],
  anthropic: [
    { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    { value: "claude-opus-4", label: "Claude Opus 4" },
  ],
};

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  gemini: "gemini-3.5-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5",
};

const LEGACY_MODEL_MAP: Record<string, string> = {
  "gemini-2.5-flash": "gemini-3.5-flash",
  "gemini-2.5-flash-lite": "gemini-3.1-flash-lite",
};

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
