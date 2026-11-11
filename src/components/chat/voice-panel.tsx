"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VoiceTransportBoundary } from "./voice/transport-boundary";
import { ProposedActionsCard } from "./proposed-actions";
import type { StoredProposedAction } from "@/lib/chat-proposed-actions";
import { VOICE_DURATION_SECONDS } from "@/lib/voice/policy";
import {
  PROVIDER_LABELS,
  type VoiceHistory,
  type VoiceProvider,
} from "@/lib/voice/config";
import type {
  VoiceAgentControls,
  VoiceAgentEvents,
  VoiceMode,
  VoicePublicState,
  VoiceSessionStart,
} from "@/lib/voice/contracts";
const DeepgramAdapter = dynamic(
  () => import("./voice/deepgram-adapter").then((m) => m.DeepgramAdapter),
  { ssr: false },
);
const ElevenLabsAdapter = dynamic(
  () => import("./voice/elevenlabs-adapter").then((m) => m.ElevenLabsAdapter),
  { ssr: false },
);
class VoiceRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function command(body: Record<string, unknown>) {
  const response = await fetch("/api/voice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(body.action === "start" ? 45000 : 12000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new VoiceRequestError(
      data.error || "Orbit Voice is unavailable. Try again.",
      response.status,
    );
  return data;
}
export function VoicePanel({ state }: { state: VoicePublicState }) {
  const [active, setActive] = useState<VoiceSessionStart | null>(null);
  const [mode, setMode] = useState<VoiceMode>("disconnected");
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [failed, setFailed] = useState(false);
  const [lastProvider, setLastProvider] = useState<VoiceProvider>(
    state.provider,
  );
  const [lines, setLines] = useState<VoiceHistory>([]);
  const [cards, setCards] = useState<
    Array<{ messageId: string; action: StoredProposedAction }>
  >([]);
  const session = useRef<string | null>(null);
  const controls = useRef<VoiceAgentControls | null>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  const starting = useRef(false);
  const panel = useRef<HTMLElement | null>(null);
  const follow = useRef(true);
  const stop = useCallback(async (outcome: "ended" | "failed" = "ended") => {
    generation.current++;
    const id = session.current;
    session.current = null;
    const driver = controls.current;
    controls.current = null;
    driver?.disconnect();
    if (alive.current) {
      setActive(null);
      setBusy(false);
      setMuted(false);
      setMode("disconnected");
    }
    if (id)
      await command({ action: "end", sessionId: id, outcome }).catch(() => {});
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const id = session.current;
      session.current = null;
      controls.current?.disconnect();
      controls.current = null;
      if (id)
        void fetch("/api/voice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "end", sessionId: id }),
          keepalive: true,
        }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (panel.current && follow.current)
      panel.current.scrollTop = panel.current.scrollHeight;
  }, [lines, cards]);
  useEffect(() => {
    if (!active) return;
    const id = active.sessionId;
    const deadline = setTimeout(
      () => {
        if (session.current === id) {
          setError(
            "This voice session has reached its time limit. Start a new conversation.",
          );
          void stop();
        }
      },
      Math.max(0, new Date(active.expiresAt).getTime() - Date.now()),
    );
    const heartbeat = setInterval(() => {
      void command({ action: "heartbeat", sessionId: id }).catch(() => {
        if (session.current !== id) return;
        setFailed(false);
        setError(
          "Voice settings changed or this session ended. Start a new conversation.",
        );
        void stop();
      });
    }, 15000);
    return () => {
      clearTimeout(deadline);
      clearInterval(heartbeat);
    };
  }, [active, stop]);
  const events = useMemo<VoiceAgentEvents>(() => {
    const id = active?.sessionId;
    const current = () =>
      Boolean(id && alive.current && session.current === id);
    return {
      onReady: (driver) => {
        if (current()) controls.current = driver;
      },
      onConnected: () => {
        if (current())
          void command({ action: "connected", sessionId: id }).catch(() => {
            if (current()) void stop("failed");
          });
      },
      onMode: (next) => {
        if (current()) {
          setMode(next);
          if (next !== "connecting") setBusy(false);
        }
      },
      onMessage: (source, text) => {
        if (current()) setLines((old) => [...old.slice(-49), { source, text }]);
      },
      onCorrection: (original, corrected) => {
        if (current())
          setLines((old) => {
            const index = old.findLastIndex(
              (line) => line.source === "ai" && line.text === original,
            );
            return old.map((line, i) =>
              i === index ? { ...line, text: corrected } : line,
            );
          });
      },
      onError: () => {
        if (current()) {
          setFailed(true);
          setError(
            "The voice provider couldn’t connect or the call was interrupted. Try again.",
          );
          void stop("failed");
        }
      },
      onDisconnected: () => {
        if (current()) {
          setFailed(true);
          setError(
            "The voice connection ended. You can start another conversation.",
          );
          void stop("failed");
        }
      },
      onTool: async (tool, input) => {
        try {
          if (!current())
            return JSON.stringify({ error: "Voice session ended" });
          const response = await command({
            action: "tool",
            sessionId: id,
            tool,
            input: JSON.parse(input),
          });
          if (!current())
            return JSON.stringify({ error: "Voice session ended" });
          if (response.proposal) setCards((old) => [...old, response.proposal]);
          return response.result;
        } catch {
          return JSON.stringify({
            error:
              "The CRM lookup or proposal failed. Ask the user to retry; do not claim success.",
          });
        }
      },
    };
  }, [active, stop]);
  async function start(fallback = false) {
    if (starting.current || session.current) return;
    starting.current = true;
    const attempt = ++generation.current;
    setBusy(true);
    setMode("connecting");
    setError("");
    setFailed(false);
    setLastProvider(
      fallback && state.fallbackProvider
        ? state.fallbackProvider
        : state.provider,
    );
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new VoiceRequestError(
          "Microphone access needs a supported browser and HTTPS.",
          400,
        );
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      if (!alive.current || attempt !== generation.current) return;
      const response: VoiceSessionStart = await command({
        action: "start",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        fallback,
        history: lines
          .slice(-12)
          .map((line) => ({ ...line, text: line.text.slice(0, 500) })),
      });
      if (!alive.current || attempt !== generation.current) {
        await command({ action: "end", sessionId: response.sessionId }).catch(
          () => {},
        );
        return;
      }
      session.current = response.sessionId;
      setLastProvider(response.credentials.provider);
      setActive(response);
    } catch (err) {
      if (alive.current) {
        const denied = err instanceof Error && err.name === "NotAllowedError";
        setFailed(
          !denied && (!(err instanceof VoiceRequestError) || err.status >= 500),
        );
        setError(
          denied
            ? "Microphone access was denied. Allow it in your browser settings, then try again."
            : err instanceof VoiceRequestError
              ? err.message
              : "Couldn’t start Orbit Voice. Check your microphone and try again.",
        );
      }
      await stop("failed");
    } finally {
      starting.current = false;
    }
  }
  const provider = active?.credentials.provider ?? lastProvider;
  const connected = active && mode !== "connecting" && mode !== "disconnected";
  return (
    <section
      aria-label="Orbit Voice"
      ref={panel}
      onScroll={(event) => {
        const el = event.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="mt-3 max-h-[min(30dvh,15rem)] overflow-y-auto rounded-xl border border-border bg-card p-4 sm:max-h-[min(40dvh,24rem)]"
    >
      {active && (
        <VoiceTransportBoundary
          key={active.sessionId}
          onFailure={events.onError}
        >
          {active?.credentials.provider === "deepgram" && (
            <DeepgramAdapter
              key={active.sessionId}
              credentials={active.credentials}
              events={events}
            />
          )}
          {active?.credentials.provider === "elevenlabs" && (
            <ElevenLabsAdapter
              key={active.sessionId}
              credentials={active.credentials}
              events={events}
            />
          )}
        </VoiceTransportBoundary>
      )}
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 bg-card pb-2">
        <div>
          <h2 className="text-sm font-medium">
            Orbit Voice · {PROVIDER_LABELS[provider]}
          </h2>
          <p role="status" className="mt-1 text-xs text-muted-foreground">
            {busy
              ? "Connecting…"
              : mode === "speaking"
                ? "Orbit is speaking · interrupt anytime"
                : mode === "thinking"
                  ? "Looking that up…"
                  : connected
                    ? muted
                      ? "Microphone muted"
                      : "Listening…"
                    : "Search, prepare, or log an interaction. Changes wait for your confirmation."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {connected && (
            <Button
              size="sm"
              variant="outline"
              aria-pressed={muted}
              onClick={() => {
                controls.current?.setMuted(!muted);
                setMuted(!muted);
              }}
            >
              {muted ? (
                <MicOff className="size-4" aria-hidden />
              ) : (
                <Mic className="size-4" aria-hidden />
              )}
              {muted ? "Unmute" : "Mute"}
            </Button>
          )}
          {busy || active ? (
            <Button size="sm" variant="outline" onClick={() => void stop()}>
              <PhoneOff className="size-4" aria-hidden />
              End call
            </Button>
          ) : (
            <Button size="sm" onClick={() => void start()}>
              <Mic className="size-4" aria-hidden />
              {error
                ? `Retry ${PROVIDER_LABELS[state.provider]}`
                : "Start conversation"}
            </Button>
          )}
        </div>
      </div>
      {!active && (
        <p className="mt-2 text-xs text-muted-foreground">
          Your audio and relevant CRM context are processed by{" "}
          {PROVIDER_LABELS[state.provider]}. App sessions end after{" "}
          {VOICE_DURATION_SECONDS / 60} minutes.
        </p>
      )}
      {error && (
        <div className="mt-3 space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          {failed &&
            !active &&
            state.fallbackProvider &&
            lastProvider === state.provider && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void start(true)}
              >
                Try {PROVIDER_LABELS[state.fallbackProvider]}
              </Button>
            )}
        </div>
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
            try {
              controls.current?.sendContext(
                `The user ${next.status === "done" ? "confirmed and saved" : next.status} the proposal: ${next.preview}`,
              );
            } catch {
              /* The call may have ended while the card saved. */
            }
          }}
        />
      ))}
    </section>
  );
}
