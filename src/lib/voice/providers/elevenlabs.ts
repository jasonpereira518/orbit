import { UserFacingError } from "@/lib/errors";
import { agentOverrides, isSafeVoiceAgent } from "../agent-config";
import type { VoiceConfig } from "../config";
import type { VoiceCredentials } from "../contracts";
export async function elevenCredentials(
  instructions: string,
  config: VoiceConfig,
  guard: () => Promise<unknown> = async () => {},
): Promise<VoiceCredentials> {
  const agentResponse = await fetch(
    `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(process.env.ELEVENLABS_AGENT_ID!)}`,
    {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    },
  );
  // Say WHY in the log (reportError in voiceCredentials): a deleted agent or an ID from another
  // workspace is a 404, and the person only ever sees the generic "couldn't connect" line.
  if (agentResponse.status === 404)
    throw new Error(
      "ElevenLabs agent not found (HTTP 404): ELEVENLABS_AGENT_ID doesn't exist for this API key's workspace. Run scripts/setup-orbit-voice.ts --create and update the ID.",
    );
  if (!agentResponse.ok)
    throw new Error(`ElevenLabs agent lookup failed (HTTP ${agentResponse.status})`);
  const agent = await agentResponse.json();
  const toolIds: unknown = agent?.conversation_config?.agent?.prompt?.tool_ids;
  let resolvedTools: unknown[] | undefined;
  if (toolIds !== undefined && toolIds !== null) {
    if (
      !Array.isArray(toolIds) ||
      toolIds.length !== 1 ||
      typeof toolIds[0] !== "string"
    ) {
      throw new UserFacingError(
        "Orbit Voice’s agent must use only the orbit_tool client tool",
      );
    }
    await guard();
    const toolResponse = await fetch(
      `https://api.elevenlabs.io/v1/convai/tools/${encodeURIComponent(toolIds[0])}`,
      {
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      },
    );
    resolvedTools = toolResponse.ok
      ? [(await toolResponse.json()).tool_config]
      : [];
  }
  if (!isSafeVoiceAgent(agent, resolvedTools)) {
    throw new UserFacingError(
      "Orbit Voice’s private agent needs configuration. Please contact an administrator",
    );
  }
  await guard();
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(process.env.ELEVENLABS_AGENT_ID!)}`,
    {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok)
    throw new UserFacingError(
      "Couldn’t connect to Orbit Voice. Try again in a moment",
    );
  const payload = await response.json();
  if (
    typeof payload.signed_url !== "string" ||
    !payload.signed_url.startsWith("wss://")
  )
    throw new Error("Invalid ElevenLabs session response");

  const overrides = agentOverrides(agent)?.tts;
  const tts: { modelId?: string; voiceId?: string } = {};
  if (overrides?.model_id === true) tts.modelId = config.elevenlabs.ttsModel;
  else if (
    agent?.conversation_config?.tts?.model_id !== config.elevenlabs.ttsModel
  )
    throw new UserFacingError(
      "Enable TTS model overrides on the ElevenLabs agent",
    );
  if (config.elevenlabs.voiceId) {
    if (overrides?.voice_id !== true)
      throw new UserFacingError(
        "Enable voice overrides on the ElevenLabs agent",
      );
    tts.voiceId = config.elevenlabs.voiceId;
  }
  return {
    provider: "elevenlabs",
    signedUrl: payload.signed_url,
    instructions,
    tts,
  };
}
