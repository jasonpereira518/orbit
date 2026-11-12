"use client";
import { useEffect } from "react";
import { AgentSession, AgentMicrophone, AgentPlayer } from "@deepgram/agents";
import type { VoiceCredentials, VoiceAgentEvents } from "@/lib/voice/contracts";
export function DeepgramAdapter({
  credentials,
  events,
}: {
  credentials: Extract<VoiceCredentials, { provider: "deepgram" }>;
  events: VoiceAgentEvents;
}) {
  useEffect(() => {
    let closed = false;
    let ready = false;
    let playbackTimer: ReturnType<typeof setTimeout> | undefined;
    const agent = new AgentSession({
      auth: { tokenFactory: async () => credentials.accessToken },
      agent: credentials.agent,
      audio: {
        input: { encoding: "linear16", sampleRate: 16000 },
        output: { encoding: "linear16", sampleRate: 24000 },
      },
      reconnect: { enabled: false },
      tags: ["orbit-voice"],
    });
    const player = new AgentPlayer({ sampleRate: 24000 });
    const microphone = new AgentMicrophone(
      (data) => {
        if (!closed && ready) agent.sendAudio(data);
      },
      { sampleRate: 16000 },
    );
    const fail = () => {
      if (!closed) events.onError();
    };
    events.onReady({
      getLevels: () => ({ input: microphone.getInputVolume(), output: player.getOutputVolume() }),
      disconnect: () => {
        closed = true;
        clearTimeout(playbackTimer);
        microphone.stop();
        player.dispose();
        agent.disconnect();
      },
      setMuted: (value) => {
        if (value) microphone.mute();
        else microphone.unmute();
      },
      // A confirmed CRM result is an Orbit-authored agent update, never a fabricated user command.
      sendContext: (text) => agent.injectAgentMessage(text),
    });
    agent.on("settings-applied", () => {
      if (closed) return;
      ready = true;
      void microphone
        .start()
        .then(() => {
          if (closed) {
            microphone.stop();
            return;
          }
          events.onConnected();
          events.onMode("listening");
        })
        .catch(fail);
    });
    agent.on("conversation-text", (message) => {
      if (!closed)
        events.onMessage(
          message.role === "user" ? "user" : "ai",
          message.content,
        );
    });
    agent.on("audio", (data) => {
      if (!closed) {
        player.queue(data);
        events.onMode("speaking");
      }
    });
    agent.on("user-started-speaking", () => {
      clearTimeout(playbackTimer);
      player.interrupt();
      if (!closed) events.onInterrupted();
      if (!closed) events.onMode("listening");
    });
    agent.on("agent-thinking", () => {
      if (!closed) events.onMode("thinking");
    });
    agent.on("agent-audio-done", () => {
      clearTimeout(playbackTimer);
      playbackTimer = setTimeout(
        () => {
          if (!closed) events.onMode("listening");
        },
        Math.ceil(player.getRemainingPlaybackTime() * 1000),
      );
    });
    agent.on("function-call-request", async (message) => {
      // Deliberately serialize: every proposal uses only the IDs previous lookups actually returned.
      for (const fn of message.functions) {
        if (closed) break;
        let result = JSON.stringify({ error: "Unknown voice tool" });
        if (fn.name === "orbit_tool" && fn.client_side) {
          try {
            const args = JSON.parse(fn.arguments) as {
              tool: string;
              input: string;
            };
            result = await events.onTool(args.tool, args.input);
          } catch {
            result = JSON.stringify({ error: "Invalid CRM tool arguments" });
          }
        }
        if (!closed) agent.sendFunctionCallResponse(fn.id, fn.name, result);
      }
    });
    agent.on("error", fail);
    agent.on("sdk-error", fail);
    microphone.on("error", fail);
    agent.on("disconnected", () => {
      if (!closed) events.onDisconnected();
    });
    queueMicrotask(() => {
      if (!closed) void agent.connect().catch(fail);
    });
    const handshake = setTimeout(() => {
      if (!ready) fail();
    }, 15000);
    return () => {
      closed = true;
      ready = false;
      clearTimeout(handshake);
      clearTimeout(playbackTimer);
      microphone.stop();
      player.dispose();
      agent.disconnect();
      events.onReady(null);
    };
  }, [credentials, events]);
  return null;
}
