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
    // The current line's audio, for paced captions: linear16 at 24 kHz is 48,000 bytes a second.
    let lineBytes = 0;
    let lineComplete = false;
    let lineLive = false;
    // The line's words. Its text may arrive before or after its audio: a text that comes while no
    // line is waiting for one is held for the next line's first audio.
    let lineText: string | null = null;
    let pendingText: string | null = null;
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
      // No sendContext: injectAgentMessage SPEAKS its text, so silent notes ride on tool results.
      // Queued: a fixed line waits for the agent's current answer instead of cutting it off.
      say: (text) => agent.injectAgentMessage(text, "queue"),
      getPlayback: () => {
        if (!lineLive) return null;
        const queued = lineBytes / 48000;
        return { text: lineText, played: Math.max(0, queued - player.getRemainingPlaybackTime()), queued, complete: lineComplete };
      },
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
      if (message.role !== "user") {
        if (lineLive && !lineComplete && !lineText) lineText = message.content;
        else pendingText = message.content;
      }
      if (!closed)
        events.onMessage(
          message.role === "user" ? "user" : "ai",
          message.content,
        );
    });
    agent.on("audio", (data) => {
      if (!closed) {
        // The first audio after a finished or interrupted line starts a new one.
        if (!lineLive || lineComplete) {
          lineBytes = 0;
          lineComplete = false;
          lineLive = true;
          lineText = pendingText;
          pendingText = null;
        }
        lineBytes += data.byteLength;
        player.queue(data);
        events.onMode("speaking");
      }
    });
    agent.on("user-started-speaking", () => {
      if (!closed) events.onUserStarted?.();
      lineLive = false;
      clearTimeout(playbackTimer);
      player.interrupt();
      if (!closed) events.onInterrupted();
      if (!closed) events.onMode("listening");
    });
    agent.on("agent-thinking", () => {
      if (!closed) events.onMode("thinking");
    });
    agent.on("agent-audio-done", () => {
      lineComplete = true;
      clearTimeout(playbackTimer);
      playbackTimer = setTimeout(
        () => {
          if (!closed) events.onMode("listening");
        },
        Math.ceil(player.getRemainingPlaybackTime() * 1000),
      );
    });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the callback is async by design; failures are handled inside it
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
