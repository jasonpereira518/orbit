import { z } from "zod";
export const VOICE_PROVIDERS = ["deepgram", "elevenlabs"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];
export const PROVIDER_LABELS: Record<VoiceProvider, string> = {
  deepgram: "Deepgram",
  elevenlabs: "ElevenLabs",
};
/**
 * Deepgram's Aura-2 English voices (developers.deepgram.com/docs/tts-models, Nov 2026): American,
 * plus British (draco, pandora) and Australian (hyperion, theia) accents. Asteria stays first:
 * it is the default every saved config started from.
 */
export const DEEPGRAM_VOICES = [
  "aura-2-asteria-en",
  "aura-2-amalthea-en",
  "aura-2-andromeda-en",
  "aura-2-apollo-en",
  "aura-2-arcas-en",
  "aura-2-aries-en",
  "aura-2-athena-en",
  "aura-2-atlas-en",
  "aura-2-aurora-en",
  "aura-2-callista-en",
  "aura-2-cora-en",
  "aura-2-cordelia-en",
  "aura-2-delia-en",
  "aura-2-draco-en",
  "aura-2-electra-en",
  "aura-2-harmonia-en",
  "aura-2-helena-en",
  "aura-2-hera-en",
  "aura-2-hermes-en",
  "aura-2-hyperion-en",
  "aura-2-iris-en",
  "aura-2-janus-en",
  "aura-2-juno-en",
  "aura-2-jupiter-en",
  "aura-2-luna-en",
  "aura-2-mars-en",
  "aura-2-minerva-en",
  "aura-2-neptune-en",
  "aura-2-odysseus-en",
  "aura-2-ophelia-en",
  "aura-2-orion-en",
  "aura-2-orpheus-en",
  "aura-2-pandora-en",
  "aura-2-phoebe-en",
  "aura-2-pluto-en",
  "aura-2-saturn-en",
  "aura-2-selene-en",
  "aura-2-thalia-en",
  "aura-2-theia-en",
  "aura-2-vesta-en",
  "aura-2-zeus-en",
] as const;
export const DEEPGRAM_THINK_MODELS = ["gpt-4o-mini", "gpt-4o"] as const;
export const ELEVEN_TTS_MODELS = [
  "eleven_flash_v2_5",
  "eleven_turbo_v2_5",
] as const;
export const voiceConfigSchema = z
  .object({
    provider: z.enum(VOICE_PROVIDERS).default("deepgram"),
    fallback: z.enum(["none", "offer-alternative"]).default("none"),
    deepgram: z
      .object({
        listenModel: z.enum(["nova-3", "nova-2"]).default("nova-3"),
        thinkModel: z.enum(DEEPGRAM_THINK_MODELS).default("gpt-4o-mini"),
        voice: z.enum(DEEPGRAM_VOICES).default("aura-2-asteria-en"),
      })
      .default({
        listenModel: "nova-3",
        thinkModel: "gpt-4o-mini",
        voice: "aura-2-asteria-en",
      }),
    elevenlabs: z
      .object({
        voiceId: z
          .string()
          .max(64)
          .regex(/^[a-zA-Z0-9_-]*$/)
          .default(""),
        ttsModel: z.enum(ELEVEN_TTS_MODELS).default("eleven_flash_v2_5"),
      })
      .default({ voiceId: "", ttsModel: "eleven_flash_v2_5" }),
  })
  .strict();
export type VoiceConfig = z.infer<typeof voiceConfigSchema>;
export const DEFAULT_VOICE_CONFIG = voiceConfigSchema.parse({});
export function otherVoiceProvider(provider: VoiceProvider): VoiceProvider {
  return provider === "deepgram" ? "elevenlabs" : "deepgram";
}
export function selectedVoiceProvider(
  config: VoiceConfig,
  fallback = false,
): VoiceProvider {
  if (fallback && config.fallback !== "offer-alternative")
    throw new Error("Voice fallback is not enabled");
  return fallback ? otherVoiceProvider(config.provider) : config.provider;
}
export type VoiceHealth = {
  status: "ready" | "error";
  checkedAt: string;
  code: string;
};
export type VoiceHealthMap = Partial<Record<VoiceProvider, VoiceHealth>>;
export type VoiceHistory = Array<{ source: "user" | "ai"; text: string }>;

/** Provider-neutral bridge; both agent adapters use exactly this argument contract. */
export const CRM_VOICE_TOOL = {
  name: "orbit_tool",
  description:
    "Read authenticated CRM context or propose a change using the session catalog. Changes require the user's confirmation card.",
  parameters: {
    type: "object",
    required: ["tool", "input"],
    properties: {
      tool: {
        type: "string",
        description: "Exact tool name from the session catalog.",
      },
      input: {
        type: "string",
        description: "JSON-encoded arguments matching that tool’s schema.",
      },
    },
  },
};
