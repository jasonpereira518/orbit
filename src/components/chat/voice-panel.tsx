"use client";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProposedActionsCard } from "./proposed-actions";
import type { StoredProposedAction } from "@/lib/chat-proposed-actions";
import { VOICE_DURATION_SECONDS } from "@/lib/voice/policy";

class VoiceRequestError extends Error {}

async function command(body: Record<string, unknown>) {
  const res = await fetch("/api/voice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok)
    throw new VoiceRequestError(
      data.error || "Orbit Voice is unavailable. Try again.",
    );
  return data;
}
export function VoicePanel() {
  return (
    <ConversationProvider>
      <VoiceConversation />
    </ConversationProvider>
  );
}
function VoiceConversation() {
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [lines, setLines] = useState<Array<{ source: string; text: string }>>(
    [],
  );
  const [cards, setCards] = useState<
    Array<{ messageId: string; action: StoredProposedAction }>
  >([]);
  const panel = useRef<HTMLElement | null>(null);
  const followingTranscript = useRef(true);
  const session = useRef<string | null>(null);
  const alive = useRef(true);
  const starting = useRef(false);
  const generation = useRef(0);
  const conversation = useConversation({
    micMuted: muted,
    onMessage: ({ message, source }) =>
      setLines((old) => [...old.slice(-49), { source, text: message }]),
    onAgentResponseCorrection: ({
      original_agent_response,
      corrected_agent_response,
    }) =>
      setLines((old) => {
        const index = old.findLastIndex(
          (line) =>
            line.source !== "user" && line.text === original_agent_response,
        );
        return index < 0
          ? old
          : old.map((line, i) =>
              i === index ? { ...line, text: corrected_agent_response } : line,
            );
      }),
    onError: () => {
      setError(
        "The voice connection was interrupted. Check your microphone and try again.",
      );
      void stop();
    },
    onDisconnect: () => {
      const id = session.current;
      session.current = null;
      if (id) void command({ action: "end", sessionId: id }).catch(() => {});
    },
    clientTools: {
      orbit_tool: async ({ tool, input }: { tool: string; input: string }) => {
        try {
          if (!session.current)
            return JSON.stringify({ error: "Voice session ended." });
          const result = await command({
            action: "tool",
            sessionId: session.current,
            tool,
            input: JSON.parse(input),
          });
          if (alive.current && result.proposal)
            setCards((old) => [...old, result.proposal]);
          return result.result;
        } catch {
          return JSON.stringify({
            error:
              "That lookup or proposal failed. Ask the user to try again; do not claim success.",
          });
        }
      },
    },
  });
  const { endSession } = conversation;
  useEffect(() => {
    const element = panel.current;
    if (element && followingTranscript.current)
      element.scrollTop = element.scrollHeight;
  }, [lines, cards]);
  async function stop() {
    generation.current++;
    const id = session.current;
    session.current = null;
    endSession();
    if (id) await command({ action: "end", sessionId: id }).catch(() => {});
    if (alive.current) {
      setBusy(false);
      setMuted(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      endSession();
      const id = session.current;
      session.current = null;
      if (id)
        void fetch("/api/voice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "end", sessionId: id }),
          keepalive: true,
        }).catch(() => {});
    };
  }, [endSession]);
  useEffect(() => {
    if (conversation.status !== "connected") return;
    const deadline = setTimeout(
      () => void stop(),
      VOICE_DURATION_SECONDS * 1000,
    );
    const heartbeat = setInterval(() => {
      const id = session.current;
      if (id)
        void command({ action: "heartbeat", sessionId: id }).catch(() => {
          setError(
            "This voice session has ended. Text chat is still available.",
          );
          void stop();
        });
    }, 15000);
    return () => {
      clearTimeout(deadline);
      clearInterval(heartbeat);
    };
    // Session status controls the lifetime, not each transcript render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.status]);
  async function start() {
    if (starting.current || busy || conversation.status !== "disconnected")
      return;
    starting.current = true;
    const attempt = ++generation.current;
    setBusy(true);
    setError("");
    setLines([]);
    setCards([]);
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new VoiceRequestError(
          "Microphone access needs a supported browser and HTTPS.",
        );
      // Check permission before minting a billable session; never retain this probe stream.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      if (!alive.current || attempt !== generation.current) return;
      const data = await command({
        action: "start",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (!alive.current || attempt !== generation.current) {
        await command({ action: "end", sessionId: data.sessionId });
        return;
      }
      session.current = data.sessionId;
      conversation.startSession({
        signedUrl: data.signedUrl,
        connectionType: "websocket",
        overrides: { agent: { prompt: { prompt: data.instructions } } },
      });
      if (!alive.current || attempt !== generation.current) endSession();
    } catch (err) {
      if (alive.current)
        setError(
          err instanceof Error && err.name === "NotAllowedError"
            ? "Microphone access was denied. Allow it in your browser settings, then try again."
            : err instanceof VoiceRequestError
              ? err.message
              : "Couldn’t start Orbit Voice. Check microphone access and try again.",
        );
      await stop();
    } finally {
      starting.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const connected = conversation.status === "connected";
  const active = busy || conversation.status !== "disconnected";
  return (
    <section
      aria-label="Orbit Voice"
      ref={panel}
      onScroll={(event) => {
        const element = event.currentTarget;
        followingTranscript.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
      className="mt-3 max-h-[min(30dvh,15rem)] sm:max-h-[min(40dvh,24rem)] overflow-y-auto rounded-xl border border-border bg-card p-4"
    >
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 bg-card pb-2">
        <div>
          <h2 className="text-sm font-medium">Orbit Voice</h2>
          <p role="status" className="mt-1 text-xs text-muted-foreground">
            {busy
              ? "Connecting…"
              : connected
                ? muted
                  ? "Microphone muted"
                  : conversation.isSpeaking
                    ? "Orbit is speaking · interrupt anytime"
                    : "Listening…"
                : "Search, prepare, or log an interaction. Changes wait for your confirmation."}
          </p>
        </div>
        <div className="flex gap-2">
          {connected && (
            <Button
              size="sm"
              variant="outline"
              aria-pressed={muted}
              onClick={() => setMuted(!muted)}
            >
              {muted ? (
                <MicOff className="size-4" aria-hidden />
              ) : (
                <Mic className="size-4" aria-hidden />
              )}
              {muted ? "Unmute" : "Mute"}
            </Button>
          )}
          {active ? (
            <Button size="sm" variant="outline" onClick={() => void stop()}>
              <PhoneOff className="size-4" aria-hidden />
              End call
            </Button>
          ) : (
            <Button size="sm" onClick={() => void start()}>
              <Mic className="size-4" aria-hidden />
              Start conversation
            </Button>
          )}
        </div>
      </div>
      {!active && (
        <p className="mt-2 text-xs text-muted-foreground">
          Your audio and relevant CRM context are processed by ElevenLabs.
          Sessions end after ten minutes.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {lines.length > 0 && (
        <div
          role="log"
          aria-label="Live voice transcript"
          className="mt-4 space-y-3 text-sm"
        >
          {lines.map((line, i) => (
            <p key={i}>
              <span className="mr-2 font-medium">
                {line.source === "user" ? "You" : "Orbit"}
              </span>
              <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {line.text}
              </span>
            </p>
          ))}
        </div>
      )}
      {cards.map((card) => (
        <ProposedActionsCard
          key={card.action.id}
          {...card}
          onSettled={(next) => {
            setCards((old) =>
              old.map((c) =>
                c.action.id === next.id ? { ...c, action: next } : c,
              ),
            );
            if (connected) {
              try {
                conversation.sendContextualUpdate(
                  `The user ${next.status === "done" ? "confirmed and saved" : next.status} the proposal: ${next.preview}`,
                );
              } catch {
                /* The call may have ended while the confirmation was saving. */
              }
            }
          }}
        />
      ))}
    </section>
  );
}
