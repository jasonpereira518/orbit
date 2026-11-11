import { deepgramEnabled, mintStreamToken } from "@/lib/deepgram";
import { UserFacingError } from "@/lib/errors";
import { CRM_VOICE_TOOL } from "../config";
import type { VoiceConfig } from "../config";
import type { VoiceCredentials } from "../contracts";
export async function deepgramCredentials(
  instructions: string,
  config: VoiceConfig,
): Promise<VoiceCredentials> {
  if (!deepgramEnabled())
    throw new UserFacingError(
      "Deepgram Voice Agent isn’t configured on this deployment",
    );
  const { accessToken } = await mintStreamToken({ ttlSeconds: 30 });
  const tool = CRM_VOICE_TOOL;
  return {
    provider: "deepgram",
    accessToken,
    agent: {
      listen: {
        provider: { type: "deepgram", version: "v1", model: config.deepgram.listenModel },
      },
      think: {
        provider: { type: "open_ai", model: config.deepgram.thinkModel },
        prompt: instructions,
        functions: [
          {
            defer_until_eot: true,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        ],
      },
      speak: { provider: { type: "deepgram", model: config.deepgram.voice } },
      greeting: "Hi, I’m Orbit. Who would you like to catch up with?",
    },
  };
}
