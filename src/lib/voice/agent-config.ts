import { VOICE_DURATION_SECONDS } from "./policy";
/** Safe starting configuration. CRM schemas/instructions are supplied per authenticated session. */
export const ORBIT_VOICE_AGENT_CONFIG = {
  name: "Orbit Voice",
  conversation_config: {
    agent: {
      language: "en",
      first_message: "Hi, I’m Orbit. Who would you like to catch up with?",
      disable_first_message_interruptions: false,
      prompt: {
        prompt:
          "You are Orbit Voice. Use the authenticated session instructions and orbit_tool. Never claim a CRM change was saved before the user confirms its card.",
        llm: "gemini-2.5-flash",
        temperature: 0.2,
        max_tokens: 400,
        enable_parallel_tool_calls: false,
        tools: [
          {
            type: "client",
            name: "orbit_tool",
            description:
              "Read CRM context or propose a change using the tools listed in the session instructions. Proposals require a human confirmation card.",
            expects_response: true,
            response_timeout_secs: 30,
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
                  description:
                    "JSON-encoded object of arguments matching that tool’s schema.",
                },
              },
            },
          },
        ],
      },
    },
    tts: { model_id: "eleven_flash_v2_5" },
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
    overrides: { agent: { prompt: { prompt: true } } },
    call_limits: {
      agent_concurrency_limit: 5,
      daily_limit: 100,
      bursting_enabled: false,
    },
    privacy: { record_voice: false, retention_days: 1 },
  },
};

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
    config.platform_settings?.overrides?.agent?.prompt?.prompt === true &&
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
