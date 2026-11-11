"use client";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useEffect, useRef, useState } from "react";
import type { VoiceCredentials, VoiceAgentEvents } from "@/lib/voice/contracts";
type Props = {
  credentials: Extract<VoiceCredentials, { provider: "elevenlabs" }>;
  events: VoiceAgentEvents;
};
export function ElevenLabsAdapter(props: Props) {
  return (
    <ConversationProvider>
      <Bridge {...props} />
    </ConversationProvider>
  );
}
function Bridge({ credentials, events }: Props) {
  const [muted, setMuted] = useState(false);
  const connected = useRef(false);
  const conversation = useConversation({
    micMuted: muted,
    onConnect: () => {
      connected.current = true;
      events.onConnected();
      events.onMode("listening");
    },
    onMessage: ({ source, message }) =>
      events.onMessage(source === "user" ? "user" : "ai", message),
    onAgentResponseCorrection: ({
      original_agent_response,
      corrected_agent_response,
    }) =>
      events.onCorrection(original_agent_response, corrected_agent_response),
    onModeChange: ({ mode }) =>
      events.onMode(mode === "speaking" ? "speaking" : "listening"),
    onError: () => events.onError(),
    onDisconnect: () => events.onDisconnected(),
    clientTools: {
      orbit_tool: ({ tool, input }: { tool: string; input: string }) =>
        events.onTool(tool, input),
    },
  });
  const { startSession, endSession, sendContextualUpdate } = conversation;
  useEffect(() => {
    events.onReady({
      disconnect: endSession,
      setMuted,
      sendContext: sendContextualUpdate,
    });
    let cancelled = false;
    connected.current = false;
    queueMicrotask(() => {
      if (!cancelled) {
        try {
          startSession({
            signedUrl: credentials.signedUrl,
            connectionType: "websocket",
            overrides: {
              agent: { prompt: { prompt: credentials.instructions } },
              tts: credentials.tts,
            },
          });
        } catch {
          events.onError();
        }
      }
    });
    const timeout = setTimeout(() => {
      if (!cancelled && !connected.current) events.onError();
    }, 15000);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      events.onReady(null);
      endSession();
    };
  }, [credentials, events, startSession, endSession, sendContextualUpdate]);
  return null;
}
