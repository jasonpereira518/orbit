import type { VoiceConfig, VoiceProvider } from "../config";
import { voiceConfigured, recordVoiceHealth } from "../settings";
import { deepgramCredentials } from "./deepgram";
import { elevenCredentials } from "./elevenlabs";
export class VoiceProviderError extends Error {
  constructor(public provider: VoiceProvider) {
    super(
      "The voice provider couldn’t connect. Try again or use an available fallback.",
    );
    this.name = "VoiceProviderError";
  }
}
export async function voiceCredentials(
  provider: VoiceProvider,
  instructions: string,
  config: VoiceConfig,
  guard: () => Promise<unknown> = async () => {},
) {
  try {
    // Session setup can outlive an admin change; check again before the first vendor request.
    await guard();
    if (!voiceConfigured(provider))
      throw new Error("Provider is not configured");
    const credentials =
      provider === "deepgram"
        ? await deepgramCredentials(instructions, config)
        : await elevenCredentials(instructions, config, guard);
    await recordVoiceHealth(provider, true, "credentials-verified");
    return credentials;
  } catch (err) {
    // Never record a provider's raw response, credential, or CRM context.
    if (err instanceof Error && err.name === "VoiceUnavailableError") throw err;
    await recordVoiceHealth(
      provider,
      false,
      "credential-or-configuration-error",
    );
    throw new VoiceProviderError(provider);
  }
}
