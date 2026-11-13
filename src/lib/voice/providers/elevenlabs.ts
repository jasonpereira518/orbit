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

const ELEVEN_VOICE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
export type ElevenVoice = { id: string; name: string; detail: string };
type ElevenVoiceRow = {
  voice_id?: unknown;
  name?: unknown;
  category?: unknown;
  labels?: Record<string, unknown>;
  preview_url?: unknown;
};

/** The voices this key's workspace can use (premade and its own), for the admin picker. */
export async function listElevenVoices(): Promise<ElevenVoice[]> {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ElevenLabs voice list failed (HTTP ${res.status})`);
  const { voices } = (await res.json()) as { voices?: ElevenVoiceRow[] };
  return (voices ?? [])
    .filter((v): v is ElevenVoiceRow & { voice_id: string; name: string } =>
      typeof v.voice_id === "string" && ELEVEN_VOICE_ID.test(v.voice_id) && typeof v.name === "string")
    .map((v) => ({
      id: v.voice_id,
      name: v.name,
      detail: [v.labels?.accent, v.labels?.gender, v.labels?.age, v.category]
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .join(" · "),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A voice's own sample clip, as bytes. ElevenLabs hosts one per voice (free, no TTS credits);
 * it is fetched here rather than in the browser because the app's media-src allows only
 * same-origin, blob: and data: audio. The URL comes from ElevenLabs, never from the caller.
 */
export async function elevenVoicePreview(voiceId: string): Promise<{ bytes: Uint8Array; type: string }> {
  if (!ELEVEN_VOICE_ID.test(voiceId)) throw new Error("Invalid ElevenLabs voice id");
  const res = await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ElevenLabs voice lookup failed (HTTP ${res.status})`);
  const url = ((await res.json()) as ElevenVoiceRow).preview_url;
  if (typeof url !== "string" || !url.startsWith("https://"))
    throw new UserFacingError("This voice has no preview sample");
  const clip = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!clip.ok) throw new Error(`ElevenLabs preview fetch failed (HTTP ${clip.status})`);
  const bytes = new Uint8Array(await clip.arrayBuffer());
  if (bytes.length > 2_000_000) throw new Error("ElevenLabs preview too large");
  // The samples are MP3s that Google storage labels text/plain, so trust the bytes, not the
  // header: an ID3 tag or an MPEG frame sync, or it isn't played.
  const mp3 = (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (!mp3) throw new Error("ElevenLabs preview is not an MP3");
  return { bytes, type: "audio/mpeg" };
}
