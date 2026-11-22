import { CRM_VOICE_TOOL } from "./config";
import { VOICE_DURATION_SECONDS } from "./policy";
/** Safe starting configuration. CRM schemas/instructions are supplied per authenticated session. */
export const ORBIT_VOICE_AGENT_CONFIG = {
  name: "Cosmo",
  conversation_config: {
    agent: {
      language: "en",
      // Kept equal to COSMO_GREETING (providers/deepgram.ts); re-run scripts/setup-orbit-voice.ts to apply.
      first_message: "Hi, I’m Cosmo. What can I help with?",
      disable_first_message_interruptions: false,
      prompt: {
        prompt:
          "You are Cosmo, Orbit's voice assistant, created by Jason. Use the authenticated session instructions and orbit_tool. Never claim a CRM change was saved before the user confirms its card.",
        llm: "gemini-2.5-flash",
        temperature: 0.2,
        max_tokens: 400,
        enable_parallel_tool_calls: false,
        tools: [
          {
            ...CRM_VOICE_TOOL,
            type: "client",
            expects_response: true,
            response_timeout_secs: 30,
          },
        ],
      },
    },
    tts: { model_id: "eleven_flash_v2" },
    turn: { turn_timeout: 7, silence_end_call_timeout: 45 },
    conversation: {
      max_duration_seconds: VOICE_DURATION_SECONDS,
      client_events: [
        "audio",
        "interruption",
        "user_transcript",
        "agent_response",
        "agent_response_correction",
        "client_tool_call",
      ],
    },
  },
  platform_settings: {
    auth: { enable_auth: true },
    // ElevenLabs reads overrides under `conversation_config_override`; the old top-level
    // shape is silently dropped, leaving the system prompt and TTS overrides switched off.
    overrides: {
      conversation_config_override: {
        agent: { prompt: { prompt: true } },
        tts: { voice_id: true, model_id: true },
      },
    },
    call_limits: {
      agent_concurrency_limit: 5,
      daily_limit: 100,
      bursting_enabled: false,
    },
    privacy: { record_voice: false, retention_days: 1 },
  },
};

type OverrideFlags = {
  agent?: { prompt?: { prompt?: boolean } };
  tts?: { voice_id?: boolean; model_id?: boolean };
};
/** An agent's override switches, wherever this API version keeps them (new shape first). */
export function agentOverrides(agent: unknown): OverrideFlags | undefined {
  const overrides = (agent as { platform_settings?: { overrides?: OverrideFlags & { conversation_config_override?: OverrideFlags } } })
    ?.platform_settings?.overrides;
  return overrides?.conversation_config_override ?? overrides;
}

/** Misconfigured public/unbounded agents must never receive an Orbit-issued session. */
export function isSafeVoiceAgent(
  agent: unknown,
  resolvedTools?: unknown[],
): boolean {
  if (!agent || typeof agent !== "object") return false;
  const config = agent as typeof ORBIT_VOICE_AGENT_CONFIG;
  const duration =
    config.conversation_config?.conversation?.max_duration_seconds;
  const tools =
    resolvedTools ?? config.conversation_config?.agent?.prompt?.tools;
  const prompt = config.conversation_config?.agent?.prompt as
    | Record<string, unknown>
    | undefined;
  const noMcp = [prompt?.mcp_server_ids, prompt?.native_mcp_server_ids].every(
    (ids) => !ids || (Array.isArray(ids) && ids.length === 0),
  );
  return (
    noMcp &&
    config.platform_settings?.auth?.enable_auth === true &&
    typeof duration === "number" &&
    duration > 0 &&
    duration <= VOICE_DURATION_SECONDS &&
    agentOverrides(agent)?.agent?.prompt?.prompt === true &&
    Array.isArray(tools) &&
    tools.length === 1 &&
    tools.every((t) => {
      if (!t || typeof t !== "object") return false;
      const tool = t as Record<string, unknown>;
      return (
        tool.name === "orbit_tool" &&
        tool.type === "client" &&
        tool.expects_response === true
      );
    })
  );
}
