/** Prints a reviewable agent config by default. --create explicitly provisions a NEW private agent. */
import { config } from "dotenv";
import { ORBIT_VOICE_AGENT_CONFIG } from "../src/lib/voice/agent-config";
config({ path: ".env.local", quiet: true });
async function main() {
  if (!process.argv.includes("--create")) {
    console.log(JSON.stringify(ORBIT_VOICE_AGENT_CONFIG, null, 2));
    return;
  }
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key)
    throw new Error(
      "Set the server-only ELEVENLABS_API_KEY before provisioning.",
    );
  const toolResponse = await fetch(
    "https://api.elevenlabs.io/v1/convai/tools",
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        tool_config:
          ORBIT_VOICE_AGENT_CONFIG.conversation_config.agent.prompt.tools[0],
      }),
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!toolResponse.ok)
    throw new Error(
      `Tool creation failed (HTTP ${toolResponse.status}). No agent was created.`,
    );
  const tool = await toolResponse.json();
  if (typeof tool.id !== "string")
    throw new Error("Tool response did not contain an ID.");
  // Use the current tool_ids API rather than the legacy inline tool definitions.
  const { tools: _tools, ...prompt } =
    ORBIT_VOICE_AGENT_CONFIG.conversation_config.agent.prompt;
  const agentConfig = {
    ...ORBIT_VOICE_AGENT_CONFIG,
    conversation_config: {
      ...ORBIT_VOICE_AGENT_CONFIG.conversation_config,
      agent: {
        ...ORBIT_VOICE_AGENT_CONFIG.conversation_config.agent,
        prompt: { ...prompt, tool_ids: [tool.id] },
      },
    },
  };
  const response = await fetch(
    "https://api.elevenlabs.io/v1/convai/agents/create",
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(agentConfig),
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok)
    throw new Error(
      `Agent creation failed (HTTP ${response.status}): ${(await response.text()).slice(0, 500)}\nClient tool ${tool.id} was created; review it in ElevenLabs before retrying.`,
    );
  const data = await response.json();
  if (typeof data.agent_id !== "string")
    throw new Error("Agent response did not contain an ID.");
  console.log(
    `Created private Orbit Voice agent. Set ELEVENLABS_AGENT_ID=${data.agent_id} in your server environment.`,
  );
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : "Agent setup failed.");
  process.exitCode = 1;
});
