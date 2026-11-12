"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Mic, MicOff, X, Captions, Loader2, MessageSquare } from "lucide-react";
import { VoiceOrbit } from "./voice/voice-orbit";
import { cn } from "@/lib/utils";
import "./voice/voice-overlay.css";
import { Button, buttonVariants } from "@/components/ui/button";
import { VoiceTransportBoundary } from "./voice/transport-boundary";
import { ProposedActionsCard } from "./proposed-actions";
import type { StoredProposedAction } from "@/lib/chat-proposed-actions";
import { VOICE_DURATION_SECONDS } from "@/lib/voice/policy";
import {
  PROVIDER_LABELS,
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
    keepalive: body.action === "transcript" || body.action === "end",
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
type TranscriptTurn = { id: string; source: "user" | "ai"; text: string; interrupted: boolean; revision: number };
/**
 * The live call. Inline in Chat's conversation column (`compact` false); a small card at the
 * middle right of every other page (`compact` true). `VoiceDock` owns where it sits.
 */
export function VoicePanel({ state, threadId, onClose, compact = false }: {
  state: VoicePublicState; threadId: string; onClose(): Promise<void>; compact?: boolean;
}) {
  const [active, setActive] = useState<VoiceSessionStart | null>(null);
  const [mode, setMode] = useState<VoiceMode>("disconnected");
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [failed, setFailed] = useState(false);
  const [lastProvider, setLastProvider] = useState<VoiceProvider>(
    state.provider,
  );
  const [lines, setLines] = useState<TranscriptTurn[]>([]);
  const transcript = useRef<TranscriptTurn[]>([]);
  const [showTranscript, setShowTranscript] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const alive = useRef(true);
  const pending = useRef(new Map<string, {sessionId: string; turn: TranscriptTurn}>());
  const writes = useRef(Promise.resolve());
  const modeRef = useRef<VoiceMode>("disconnected");
  const persist = useCallback((id: string, turn: TranscriptTurn) => {
    const item = {sessionId: id, turn};
    pending.current.set(turn.id, item);
    writes.current = writes.current.then(async () => {
      try {
        await command({action: "transcript", ...item});
        if (pending.current.get(turn.id) === item) pending.current.delete(turn.id);
        if (alive.current && pending.current.size === 0) setSaveError(false);
      } catch { if (alive.current) setSaveError(true); }
    });
  }, []);
  const [cards, setCards] = useState<
    Array<{ messageId: string; action: StoredProposedAction }>
  >([]);
  const session = useRef<string | null>(null);
  const controls = useRef<VoiceAgentControls | null>(null);
  const generation = useRef(0);
  const starting = useRef(false);
  const panel = useRef<HTMLDivElement | null>(null);
  const follow = useRef(true);
  const stop = useCallback(async (outcome: "ended" | "failed" = "ended") => {
    generation.current++;
    const id = session.current;
    if (id && modeRef.current === "speaking") {
      const last = transcript.current.findLast(line => line.source === "ai");
      if (last && !last.interrupted) {
        const next = {...last, interrupted: true, revision: last.revision + 1};
        transcript.current = transcript.current.map(line => line.id === last.id ? next : line);
        if (alive.current) setLines(transcript.current);
        persist(id, next);
      }
    }
    modeRef.current = "disconnected";
    session.current = null;
    const driver = controls.current;
    controls.current = null;
    driver?.disconnect();
    await writes.current;
    if (alive.current) {
      setActive(null);
      setBusy(false);
      setMuted(false);
      setMode("disconnected");
    }
    if (id)
      await command({ action: "end", sessionId: id, outcome }).catch(() => {});
  }, [persist]);
  const close = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    await stop();
    for (const item of pending.current.values()) persist(item.sessionId, item.turn);
    await writes.current;
    if (pending.current.size) {
      setClosing(false);
      closingRef.current = false;
      setSaveError(true);
      return;
    }
    await onClose();
  }, [onClose, persist, stop]);
  useEffect(() => {
    alive.current = true;
    const unsaved = pending.current;
    return () => {
      alive.current = false;
      const id = session.current;
      session.current = null;
      controls.current?.disconnect();
      controls.current = null;
      for (const item of unsaved.values()) {
        void command({action: "transcript", ...item}).catch(() => {});
      }
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
          modeRef.current = next;
          setMode(next);
          if (next !== "connecting") setBusy(false);
        }
      },
      onMessage: (source, text) => {
        if (!current() || !text.trim()) return;
        // Providers emit finalized turns here; recognition drafts never enter Chat history.
        const turn = {id: crypto.randomUUID(), source, text: text.slice(0, 4000), interrupted: false, revision: 1};
        transcript.current = [...transcript.current, turn];
        setLines(transcript.current);
        persist(id!, turn);
      },
      onInterrupted: () => {
        if (!current() || modeRef.current !== "speaking") return;
        const last = transcript.current.findLast(line => line.source === "ai");
        if (last) {
          const next = {...last, interrupted: true, revision: last.revision + 1};
          transcript.current = transcript.current.map(line => line.id === last.id ? next : line);
          setLines(transcript.current);
          persist(id!, next);
        }
        modeRef.current = "listening";
        setMode("listening");
      },
      onCorrection: (original, corrected) => {
        if (!current()) return;
        const last = transcript.current.findLast(line => line.source === "ai" && line.text === original.slice(0, 4000));
        if (!last) return;
        const next = {...last, text: corrected.slice(0, 4000) || "[Interrupted]", interrupted: true, revision: last.revision + 1};
        transcript.current = transcript.current.map(line => line.id === last.id ? next : line);
        setLines(transcript.current);
        persist(id!, next);
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
  }, [active, stop, persist]);
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
        threadId,
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
  const startRef = useRef(start);
  useEffect(() => { startRef.current = start; });
  useEffect(() => {
    const timer = setTimeout(() => void startRef.current(), 0);
    return () => clearTimeout(timer);
  }, []);
  const root = useRef<HTMLElement | null>(null);
  // The old dialog ended the call on Escape. Keep that, but only when focus is in the panel
  // or nowhere (a button that just unmounted drops it to <body>), never from another menu.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const focus = document.activeElement;
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const nowhere = focus === document.body || focus === null;
      // Floating over another page, a stray Escape there must not hang up.
      if ((nowhere && !compact) || root.current?.contains(focus)) void close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close, compact]);
  const connected = active && mode !== "connecting" && mode !== "disconnected";
  const waiting = cards.some((card) => card.action.status === "proposed");
  return (
    <section
      aria-label="Orbit Voice"
      data-transcript={showTranscript || undefined}
      data-compact={compact || undefined}
      ref={root}
      className={cn(
        "voice-stage flex min-h-0 min-w-0 flex-col text-foreground",
        compact
          ? "w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-border/70 bg-card p-4 shadow-lg"
          : "w-full flex-1 overflow-y-auto px-6 py-4 sm:px-10",
      )}
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
      {/* One centred column: `m-auto` centres it in Chat's space, and unlike justify-center
          it still scrolls from the top when the transcript makes it taller than the page. */}
      <div className={cn("flex w-full flex-col", !compact && "m-auto max-h-full min-h-0 max-w-2xl")}>
      <div className="flex min-h-0 flex-col items-center text-center">
        <div>
          <h2 className={compact ? "text-sm font-medium" : "text-lg font-medium"}>Orbit Voice</h2>
          {!compact && (
            <p className="mt-2 text-sm text-muted-foreground">In this conversation · {PROVIDER_LABELS[provider]}</p>
          )}
        </div>
        <div className={cn("flex min-h-0 w-full items-center justify-center", compact ? "py-2" : "py-4 sm:py-6")}>
          <VoiceOrbit controls={controls} mode={mode} muted={muted} />
        </div>
        <p role="status" className="min-h-6 text-sm text-muted-foreground">
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
                  : "Ready when you are"}
        </p>
        <div className={cn("flex flex-wrap items-center justify-center gap-3", compact ? "mt-3" : "mt-5")}>
          {connected && (
            <Button
              size="sm"
              variant="secondary"
              className="h-11 rounded-full px-5"
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
          {!busy && !active && (
            <Button size="sm" className="h-11 rounded-full px-5" onClick={() => void start()}>
              <Mic className="size-4" aria-hidden />
              {error
                ? `Retry ${PROVIDER_LABELS[state.provider]}`
                : "Start conversation"}
            </Button>
          )}
          {compact ? (
            <Link
              href="/chat"
              aria-label="Open chat"
              title="Open chat"
              className={cn(buttonVariants({ variant: "secondary", size: "icon" }), "size-11 rounded-full")}
            >
              <MessageSquare className="size-4" aria-hidden />
            </Link>
          ) : (
            <Button variant="secondary" className="h-11 rounded-full px-5" aria-expanded={showTranscript} aria-controls="voice-transcript" onClick={() => setShowTranscript(value => !value)}>
              <Captions className="size-4" aria-hidden /> Transcript
            </Button>
          )}
          {/* Ending a call is calm, not alarming: a quiet gray X, never a red phone. */}
          <Button
            variant="ghost"
            size="icon"
            aria-label="End conversation"
            title="End conversation"
            className="size-11 rounded-full bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground"
            disabled={closing}
            onClick={() => void close()}
          >
            {closing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <X className="size-5" aria-hidden />}
          </Button>
        </div>
      </div>
      {saveError && <div role="status" className="mt-4 text-center text-sm">
        Some transcript turns haven’t saved yet. Keep this window open.
        <Button variant="link" onClick={async () => {
          for (const item of pending.current.values()) persist(item.sessionId, item.turn);
          await writes.current;
          setSaveError(pending.current.size > 0);
        }}>Retry saving</Button>
      </div>}
      {!active && !compact && (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Your audio and relevant CRM context are processed by{" "}
          {PROVIDER_LABELS[state.provider]}. App sessions end after{" "}
          {VOICE_DURATION_SECONDS / 60} minutes.
        </p>
      )}
      {error && (
        <div className="mt-3 space-y-2 text-center">
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
      {compact && waiting && (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          Orbit has a change for you to confirm in Chat.
        </p>
      )}
      {showTranscript && !compact && (
        <div
          id="voice-transcript"
          ref={panel}
          onScroll={(event) => {
            const el = event.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          role="log"
          aria-label="Live voice transcript"
          className="mx-auto mt-6 max-h-44 w-full max-w-2xl shrink-0 space-y-3 overflow-y-auto rounded-xl bg-muted p-4 text-sm"
        >
          {lines.length === 0 && <p className="text-muted-foreground">Your conversation will appear here.</p>}
          {lines.map((line, i) => (
            <p key={line.id || i}>
              <span className="mr-2 font-medium">
                {line.source === "user" ? "You" : "Orbit"}
              </span>
              <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {line.text}
                {line.interrupted && <span className="ml-2 text-muted-foreground">(interrupted)</span>}
              </span>
            </p>
          ))}
        </div>
      )}
      {!compact && (
        <div className="mx-auto w-full max-w-2xl">
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
        </div>
      )}
      </div>
    </section>
  );
}
