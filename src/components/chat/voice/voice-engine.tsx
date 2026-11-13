"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { VoiceTransportBoundary } from "./transport-boundary";
import { saveThemePreference } from "@/actions/settings";
import { streamChat } from "@/lib/chat-stream-client";
import { useMeetingSession } from "@/components/capture/meeting-session";
import {
  ASK_CHAT_TOOL,
  LOOK_AT_SCREEN_TOOL,
  OPEN_PAGE_TOOL,
  POINT_AT_TOOL,
  SET_CAPTIONS_TOOL,
  SET_THEME_TOOL,
  START_RECORDING_TOOL,
  VOICE_THEMES,
  voicePagePath,
} from "@/lib/voice/policy";
import { withAppEvents } from "@/lib/voice/app-events";
import { plainSpeech } from "@/lib/voice/caption-pace";
import { setCaptions } from "@/lib/cosmo/captions-pref";
import { describeScreen, readScreen } from "@/lib/cosmo/screen";
import { planPointing } from "@/lib/cosmo/pointing";
import { onPointingEvent, startPointing, stopPointing } from "@/lib/cosmo/pointer-store";
import {
  getVoiceCall,
  installVoiceActions,
  resetVoiceCall,
  setVoiceCall,
  voiceControls,
  type TranscriptTurn,
} from "@/lib/voice/call-store";
import { setCallThread, type VoiceCall } from "@/lib/voice/dock-store";
import type { VoiceAgentEvents, VoiceMode, VoicePublicState, VoiceSessionStart } from "@/lib/voice/contracts";

const DeepgramAdapter = dynamic(() => import("./deepgram-adapter").then((m) => m.DeepgramAdapter), { ssr: false });
const ElevenLabsAdapter = dynamic(() => import("./elevenlabs-adapter").then((m) => m.ElevenLabsAdapter), { ssr: false });

export { plainSpeech };
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
    throw new VoiceRequestError(data.error || "Orbit Voice is unavailable. Try again.", response.status);
  return data;
}

/**
 * The live call, headless. Mounted once per call by `VoiceDock` OUTSIDE the portal, so the
 * views (inline in Chat, docked elsewhere) can move and remount freely without hanging up.
 * Everything a view shows goes through `call-store`; everything it does goes through
 * `voiceActions`.
 */
export function VoiceEngine({ state, threadId, origin = "chat", onClose }: {
  state: VoicePublicState; threadId: string | null; origin?: VoiceCall["origin"]; onClose(): Promise<void>;
}) {
  const router = useRouter();
  const { setTheme } = useTheme();
  const meeting = useMeetingSession();
  const [active, setActive] = useState<VoiceSessionStart | null>(null);
  const transcript = useRef<TranscriptTurn[]>([]);
  const closingRef = useRef(false);
  const alive = useRef(true);
  const pending = useRef(new Map<string, { sessionId: string; turn: TranscriptTurn }>());
  const writes = useRef(Promise.resolve());
  const modeRef = useRef<VoiceMode>("disconnected");
  /** What the user did in the app, waiting to ride on the next tool result (`app_events`). */
  const appEvents = useRef<string[]>([]);
  /** The screen as the agent last heard it, so a change is told once and only once. */
  const lastScreen = useRef<string | null>(null);
  const session = useRef<string | null>(null);
  const generation = useRef(0);
  const starting = useRef(false);
  /** The call's thread; a Cosmo call learns it from the start response. */
  const thread = useRef(threadId);

  useLayoutEffect(() => {
    resetVoiceCall(state.provider);
    // Only on mount: a provider change mid-call must not wipe the live view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLines = (lines: TranscriptTurn[]) => {
    transcript.current = lines;
    setVoiceCall({ lines });
  };
  const persist = useCallback((id: string, turn: TranscriptTurn) => {
    const item = { sessionId: id, turn };
    pending.current.set(turn.id, item);
    writes.current = writes.current.then(async () => {
      try {
        await command({ action: "transcript", ...item });
        if (pending.current.get(turn.id) === item) pending.current.delete(turn.id);
        if (alive.current && pending.current.size === 0) setVoiceCall({ saveError: false });
      } catch {
        if (alive.current) setVoiceCall({ saveError: true });
      }
    });
  }, []);
  const stop = useCallback(async (outcome: "ended" | "failed" = "ended") => {
    generation.current++;
    const id = session.current;
    if (id && modeRef.current === "speaking") {
      const last = transcript.current.findLast((line) => line.source === "ai");
      if (last && !last.interrupted) {
        const next = { ...last, interrupted: true, revision: last.revision + 1 };
        const lines = transcript.current.map((line) => (line.id === last.id ? next : line));
        transcript.current = lines;
        if (alive.current) setVoiceCall({ lines });
        persist(id, next);
      }
    }
    modeRef.current = "disconnected";
    session.current = null;
    const driver = voiceControls.current;
    voiceControls.current = null;
    driver?.disconnect();
    await writes.current;
    if (alive.current) {
      setActive(null);
      setVoiceCall({ active: false, busy: false, muted: false, mode: "disconnected" });
    }
    if (id) await command({ action: "end", sessionId: id, outcome }).catch(() => {});
  }, [persist]);
  const retrySaves = useCallback(async () => {
    for (const item of pending.current.values()) persist(item.sessionId, item.turn);
    await writes.current;
  }, [persist]);
  const close = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setVoiceCall({ closing: true });
    await stop();
    await retrySaves();
    if (pending.current.size) {
      setVoiceCall({ closing: false, saveError: true });
      closingRef.current = false;
      return;
    }
    await onClose();
  }, [onClose, retrySaves, stop]);

  useEffect(() => {
    alive.current = true;
    const unsaved = pending.current;
    return () => {
      alive.current = false;
      const id = session.current;
      session.current = null;
      voiceControls.current?.disconnect();
      voiceControls.current = null;
      for (const item of unsaved.values()) void command({ action: "transcript", ...item }).catch(() => {});
      if (id)
        void fetch("/api/voice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "end", sessionId: id }),
          keepalive: true,
        }).catch(() => {});
      resetVoiceCall();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const id = active.sessionId;
    const deadline = setTimeout(
      () => {
        if (session.current === id) {
          setVoiceCall({ error: "This voice session has reached its time limit. Start a new conversation." });
          void stop();
        }
      },
      Math.max(0, new Date(active.expiresAt).getTime() - Date.now()),
    );
    const heartbeat = setInterval(() => {
      void command({ action: "heartbeat", sessionId: id }).catch(() => {
        if (session.current !== id) return;
        setVoiceCall({ failed: false, error: "Voice settings changed or this session ended. Start a new conversation." });
        void stop();
      });
    }, 15000);
    return () => {
      clearTimeout(deadline);
      clearInterval(heartbeat);
    };
  }, [active, stop]);

  /**
   * ask_chat: the question goes to Orbit Chat in this call's own thread, exactly as if typed.
   * A spoken answer can't wait minutes, so after 20 seconds the agent is told Chat is still
   * working; the turn finishes server-side regardless and shows in the thread.
   */
  const askChat = useCallback(async (question: unknown) => {
    if (typeof question !== "string" || !question.trim())
      return JSON.stringify({ error: "Give ask_chat a question." });
    let answer = "";
    const finished = new Promise<string | null>((resolve) => {
      void streamChat(
        { question: question.trim().slice(0, 2000), threadId: thread.current ?? undefined, turnId: crypto.randomUUID() },
        {
          onAnswer: (delta) => { answer += delta; },
          onRecommendations: () => {},
          onDone: () => resolve(null),
          onError: (message) => resolve(message),
        },
      );
    });
    const outcome = await Promise.race([
      finished,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20_000)),
    ]);
    if (outcome === "pending")
      return JSON.stringify({ status: "still_working", note: "Chat is still answering. The full answer will appear in this conversation." });
    if (outcome) return JSON.stringify({ error: outcome });
    return JSON.stringify({ untrusted_chat_answer: plainSpeech(answer).slice(0, 3000) });
  }, []);

  const events = useMemo<VoiceAgentEvents>(() => {
    const id = active?.sessionId;
    const current = () => Boolean(id && alive.current && session.current === id);
    const runTool = async (tool: string, input: string): Promise<string> => {
      try {
        if (!current()) return JSON.stringify({ error: "Voice session ended" });
        // App control runs here, not on the server: the call lives in the layout, so it keeps
        // going on the page it opens. Only allowlisted pages; record pages need a real id.
        const args = JSON.parse(input || "{}") as Record<string, unknown>;
        if (tool === ASK_CHAT_TOOL) return await askChat(args.question);
        if (tool === START_RECORDING_TOOL) {
          if (!meeting?.ready)
            return JSON.stringify({ error: "The meeting recorder isn't ready on this page yet. Try again in a moment." });
          meeting.startRecording(null, "mic");
          router.push("/meetings");
          return JSON.stringify({ started: true, note: "Recording on the microphone. The user can pause or finish it on Meetings." });
        }
        if (tool === SET_THEME_TOOL) {
          const theme = VOICE_THEMES.find((t) => t === args.theme);
          if (!theme) return JSON.stringify({ error: "Theme must be light, dark or system." });
          setTheme(theme);
          void saveThemePreference(theme).catch(() => {});
          return JSON.stringify({ theme });
        }
        if (tool === POINT_AT_TOOL) {
          // A cursor needs a pointer and room to glide: computers only.
          if (!window.matchMedia("(min-width: 768px)").matches)
            return JSON.stringify({ error: "Pointing works on a computer screen. Describe where it is instead." });
          const plan = planPointing(args.targets, readScreen());
          if ("error" in plan) return JSON.stringify({ error: plan.error });
          startPointing(plan.steps);
          return JSON.stringify({
            pointing: plan.steps.map((step) => step.label),
            note: "Your cursor is on screen now. Say what to click; app_events will tell you when they do.",
          });
        }
        if (tool === LOOK_AT_SCREEN_TOOL) {
          const screen = describeScreen(readScreen());
          lastScreen.current = screen;
          return JSON.stringify({ screen: screen ?? "The user is on a page Cosmo cannot open or describe." });
        }
        if (tool === SET_CAPTIONS_TOOL) {
          if (typeof args.on !== "boolean") return JSON.stringify({ error: "Say on: true or on: false." });
          setCaptions(args.on);
          return JSON.stringify({ captions: args.on ? "on" : "off" });
        }
        if (tool === OPEN_PAGE_TOOL) {
          const path = voicePagePath(args.page, args.id, args.filters);
          if (!path) return JSON.stringify({ error: "Unknown page, or that page needs a valid id from a lookup." });
          router.push(path);
          return JSON.stringify({ opened: path });
        }
        const response = await command({ action: "tool", sessionId: id, tool, input: JSON.parse(input) });
        if (!current()) return JSON.stringify({ error: "Voice session ended" });
        if (response.proposal) setVoiceCall({ cards: [...getVoiceCall().cards, response.proposal] });
        return response.result;
      } catch {
        return JSON.stringify({ error: "The CRM lookup or proposal failed. Ask the user to retry; do not claim success." });
      }
    };
    return {
      onReady: (driver) => {
        if (current()) voiceControls.current = driver;
      },
      onConnected: () => {
        if (current())
          void command({ action: "connected", sessionId: id }).catch(() => {
            if (current()) void stop("failed");
          });
      },
      onMode: (next) => {
        if (!current()) return;
        modeRef.current = next;
        setVoiceCall(next !== "connecting" ? { mode: next, busy: false } : { mode: next });
      },
      onMessage: (source, text) => {
        if (!current() || !text.trim()) return;
        // Providers emit finalized turns here; recognition drafts never enter Chat history.
        const turn = { id: crypto.randomUUID(), source, text: text.slice(0, 4000), interrupted: false, revision: 1 };
        setLines([...transcript.current, turn]);
        persist(id!, turn);
      },
      onInterrupted: () => {
        if (!current() || modeRef.current !== "speaking") return;
        const last = transcript.current.findLast((line) => line.source === "ai");
        if (last) {
          const next = { ...last, interrupted: true, revision: last.revision + 1 };
          setLines(transcript.current.map((line) => (line.id === last.id ? next : line)));
          persist(id!, next);
        }
        modeRef.current = "listening";
        setVoiceCall({ mode: "listening" });
      },
      onCorrection: (original, corrected) => {
        if (!current()) return;
        const last = transcript.current.findLast((line) => line.source === "ai" && line.text === original.slice(0, 4000));
        if (!last) return;
        const next = { ...last, text: corrected.slice(0, 4000) || "[Interrupted]", interrupted: true, revision: last.revision + 1 };
        setLines(transcript.current.map((line) => (line.id === last.id ? next : line)));
        persist(id!, next);
      },
      onError: () => {
        if (!current()) return;
        setVoiceCall({ failed: true, error: "The voice provider couldn’t connect or the call was interrupted. Try again." });
        void stop("failed");
      },
      onDisconnected: () => {
        if (!current()) return;
        setVoiceCall({ failed: true, error: "The voice connection ended. You can start another conversation." });
        void stop("failed");
      },
      onTool: async (tool, input) => {
        const result = await runTool(tool, input);
        // The screen as it is now, told once whenever it has changed since the agent last heard.
        const screen = describeScreen(readScreen());
        if (screen && screen !== lastScreen.current) {
          lastScreen.current = screen;
          appEvents.current.push(`Screen now: ${screen}`);
        }
        const queued = appEvents.current;
        appEvents.current = [];
        return withAppEvents(result, queued);
      },
    };
  }, [active, stop, persist, router, meeting, setTheme, askChat]);

  // The adapters connect once per session and must NEVER see a new `events`: their effect
  // reconnects on it, and a reconnect is a new conversation ("Hi, I'm Orbit" mid-sentence).
  // `events` changes whenever the theme, the router or the meeting recorder's state does, so
  // the adapters get this stable object, which always calls the latest handlers.
  const eventsRef = useRef(events);
  useLayoutEffect(() => {
    eventsRef.current = events;
  });
  const stableEvents = useMemo<VoiceAgentEvents>(() => ({
    onReady: (controls) => eventsRef.current.onReady(controls),
    onConnected: () => eventsRef.current.onConnected(),
    onMode: (mode) => eventsRef.current.onMode(mode),
    onInterrupted: () => eventsRef.current.onInterrupted(),
    onMessage: (source, text) => eventsRef.current.onMessage(source, text),
    onCorrection: (original, corrected) => eventsRef.current.onCorrection(original, corrected),
    onError: () => eventsRef.current.onError(),
    onDisconnected: () => eventsRef.current.onDisconnected(),
    onTool: (tool, input) => eventsRef.current.onTool(tool, input),
  }), []);

  async function start(fallback = false) {
    if (starting.current || session.current) return;
    starting.current = true;
    const attempt = ++generation.current;
    setVoiceCall({
      busy: true,
      mode: "connecting",
      error: "",
      failed: false,
      provider: fallback && state.fallbackProvider ? state.fallbackProvider : state.provider,
    });
    try {
      const screen = readScreen();
      lastScreen.current = describeScreen(screen);
      if (!navigator.mediaDevices?.getUserMedia)
        throw new VoiceRequestError("Microphone access needs a supported browser and HTTPS.", 400);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      if (!alive.current || attempt !== generation.current) return;
      const response: VoiceSessionStart = await command({
        action: "start",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        fallback,
        threadId: thread.current ?? undefined,
        // Cosmo's remembered day thread may have been deleted since; start a new one then.
        freshIfMissing: origin === "cosmo",
        screen,
      });
      if (!alive.current || attempt !== generation.current) {
        await command({ action: "end", sessionId: response.sessionId }).catch(() => {});
        return;
      }
      session.current = response.sessionId;
      thread.current = response.threadId;
      setCallThread(response.threadId);
      setActive(response);
      setVoiceCall({ active: true, provider: response.credentials.provider });
    } catch (err) {
      if (alive.current) {
        const denied = err instanceof Error && err.name === "NotAllowedError";
        setVoiceCall({
          failed: !denied && (!(err instanceof VoiceRequestError) || err.status >= 500),
          error: denied
            ? "Microphone access was denied. Allow it in your browser settings, then try again."
            : err instanceof VoiceRequestError
              ? err.message
              : "Couldn’t start Orbit Voice. Check your microphone and try again.",
        });
      }
      await stop("failed");
    } finally {
      starting.current = false;
    }
  }

  // Views call these through `voiceActions`; refreshed every render so they see the latest state.
  const startRef = useRef(start);
  useLayoutEffect(() => {
    startRef.current = start;
    installVoiceActions({
      start: (fallback) => void startRef.current(fallback),
      close,
      retrySaves: async () => {
        await retrySaves();
        setVoiceCall({ saveError: pending.current.size > 0 });
      },
      toggleMute: () => {
        const muted = !getVoiceCall().muted;
        voiceControls.current?.setMuted(muted);
        setVoiceCall({ muted });
      },
      settleCard: (next) => {
        setVoiceCall({
          cards: getVoiceCall().cards.map((c) => (c.action.id === next.id ? { ...c, action: next } : c)),
        });
        const verb = next.status === "done" ? "confirmed and saved" : next.status === "undone" ? "undid" : next.status;
        const note = `The user ${verb} the change: ${next.preview}`;
        const controls = voiceControls.current;
        try {
          if (controls?.sendContext) controls.sendContext(note);
          else appEvents.current.push(note);
        } catch {
          /* The call may have ended while the card saved. */
        }
      },
    });
  });
  useEffect(() => () => installVoiceActions(null), []);
  // Pointing: what the person did with Cosmo's cursor reaches the agent on its next tool result,
  // and the next step is said aloud where the provider can speak a line (Deepgram).
  useEffect(() => {
    const off = onPointingEvent(({ note, next }) => {
      appEvents.current.push(note);
      if (next) voiceControls.current?.say?.(`Next, the ${next.label}.`);
    });
    return () => {
      off();
      stopPointing();
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void startRef.current(), 0);
    return () => clearTimeout(timer);
  }, []);

  if (!active) return null;
  return (
    <VoiceTransportBoundary key={active.sessionId} onFailure={stableEvents.onError}>
      {active.credentials.provider === "deepgram" && (
        <DeepgramAdapter key={active.sessionId} credentials={active.credentials} events={stableEvents} />
      )}
      {active.credentials.provider === "elevenlabs" && (
        <ElevenLabsAdapter key={active.sessionId} credentials={active.credentials} events={stableEvents} />
      )}
    </VoiceTransportBoundary>
  );
}
