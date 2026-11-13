"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { VoiceTransportBoundary } from "./transport-boundary";
import { saveThemePreference } from "@/actions/settings";
import { streamChat } from "@/lib/chat-stream-client";
import { useMeetingSession } from "@/components/capture/meeting-session";
import {
  ASK_CHAT_TOOL,
  LOOK_AT_SCREEN_TOOL,
  OPEN_PAGE_TOOL,
  CLICK_TOOL,
  TYPE_INTO_TOOL,
  POINT_AT_TOOL,
  SET_CAPTIONS_TOOL,
  SET_THEME_TOOL,
  VOICE_IDLE_SLEEP_MS,
  START_RECORDING_TOOL,
  VOICE_THEMES,
  voicePagePath,
} from "@/lib/voice/policy";
import { withAppEvents } from "@/lib/voice/app-events";
import { normalizeToolInput } from "@/lib/voice/tool-input";
import { CONFIRM_WINDOW_MS, confirmVerb, hasWords, isGoodbye, isUndo, judgeUtterance, norm, readBack, repromptLine, type ConfirmWindow } from "@/lib/voice/confirm-window";
import { plainSpeech } from "@/lib/voice/caption-pace";
import { setCaptions } from "@/lib/cosmo/captions-pref";
import { describeScreen, readScreen } from "@/lib/cosmo/screen";
import { planPointing, type PointStep } from "@/lib/cosmo/pointing";
import { cleanTyped, planAction } from "@/lib/cosmo/actions";
import { allNudges, isResumeInterrupting, isStopInterrupting, mayInterject, nudgeInput } from "@/lib/cosmo/nudge";
import { useAppPulse } from "@/lib/app-pulse-store";
import { onPointingEvent, startPointing, stopPointing } from "@/lib/cosmo/pointer-store";
import {
  getVoiceCall,
  installVoiceActions,
  resetVoiceCall,
  setVoiceCall,
  voiceControls,
  type TranscriptTurn,
  type VoiceCard,
} from "@/lib/voice/call-store";
import { setCallThread, type VoiceCall } from "@/lib/voice/dock-store";
import type { VoiceAgentEvents, VoiceMode, VoicePublicState, VoiceSessionStart } from "@/lib/voice/contracts";

/** "Stop interrupting", per device (orbit: localStorage like Cosmo's other preferences). */
const INTERJECT_KEY = "orbit:cosmo-interject";
function interjectionsOff(): boolean {
  try {
    return localStorage.getItem(INTERJECT_KEY) === "off";
  } catch {
    return false;
  }
}
function setInterjectionsOff(off: boolean) {
  try {
    if (off) localStorage.setItem(INTERJECT_KEY, "off");
    else localStorage.removeItem(INTERJECT_KEY);
  } catch {
    /* Private mode: the model still heard it; it applies to this call through app_events. */
  }
}

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
const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const shown = (el: Element) =>
  typeof (el as HTMLElement).checkVisibility === "function" ? (el as HTMLElement).checkVisibility() : el.getClientRects().length > 0;
/** The first visible match, waiting up to `ms` for a page or a form to bring it. */
async function waitForVisible(selector: string, ms: number): Promise<HTMLElement | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const el = [...document.querySelectorAll<HTMLElement>(selector)].find(shown);
    if (el) return el;
    await sleep(100);
  }
  return null;
}
/** When the person last typed themselves: Cosmo never types over someone mid-sentence. */
let lastUserKey = 0;
if (typeof window !== "undefined")
  window.addEventListener("keydown", (event) => {
    if (event.isTrusted) lastUserKey = Date.now();
  }, true);

/**
 * Cosmo pressing or filling one of Orbit's controls (`planAction` already said it may): its
 * cursor flies there first (desktop; a phone just acts), a sidebar link first when the control
 * is on another page. Typing goes through the field's native value setter plus an `input`
 * event, so React's controlled fields see it as typing; it never presses Enter or submits.
 */
async function performSteps(steps: PointStep[], text?: string): Promise<{ note: string } | { error: string }> {
  const cursor = window.matchMedia("(min-width: 768px)").matches;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  try {
    for (const step of steps) {
      if (cursor) startPointing([step]);
      const el = await waitForVisible(step.selector, 8000);
      if (!el) return { error: `The ${step.label} didn't show up on screen.` };
      if (cursor && !still) await sleep(650); // the cursor's flight, so it reads as Cosmo's hand
      el.scrollIntoView({ block: "nearest" });
      if (step.kind === "nav" || text === undefined) {
        el.setAttribute("data-cosmo-pressed", "");
        window.setTimeout(() => el.removeAttribute("data-cosmo-pressed"), 400);
        el.click();
        if (step.kind === "nav") await sleep(300);
        continue;
      }
      const field = el.matches("input, textarea") ? el : el.querySelector<HTMLElement>("input, textarea");
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement))
        return { error: `The ${step.label} isn't a text field.` };
      if (document.activeElement === field && Date.now() - lastUserKey < 3000)
        return { error: `The user is typing in the ${step.label} right now. Let them finish.` };
      const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setValue = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (!setValue) return { error: `The ${step.label} can't be filled in.` };
      field.focus();
      // Visible typing, about a second however long the text: a few characters per frame.
      const chunk = still ? text.length : Math.max(1, Math.ceil(text.length / 40));
      for (let n = chunk; ; n = Math.min(text.length, n + chunk)) {
        setValue.call(field, text.slice(0, n));
        field.dispatchEvent(new Event("input", { bubbles: true }));
        if (n >= text.length) break;
        await sleep(25);
      }
    }
    const last = steps[steps.length - 1];
    return {
      note:
        text === undefined
          ? `Cosmo clicked the ${last.label}.`
          : `Cosmo typed "${text.length > 60 ? `${text.slice(0, 59)}…` : text}" into the ${last.label}.`,
    };
  } finally {
    if (cursor) stopPointing();
  }
}

/**
 * A tool call that failed: the model gets the reason, and Sentry gets the tool name and kind
 * (never the arguments, which can hold CRM text), so the next "can't look it up" is visible.
 */
function toolFailure(tool: string, kind: string, message: string): string {
  void import("@sentry/nextjs")
    .then((Sentry) => Sentry.captureMessage(`orbit:voice.tool ${kind}`, { level: "warning", tags: { tool: tool.slice(0, 60), kind } }))
    .catch(() => {});
  return JSON.stringify({ error: message });
}

async function command(body: Record<string, unknown>) {
  const response = await fetch("/api/voice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    keepalive: body.action === "transcript" || body.action === "end",
    // A lookup can do a lot on a cold start (dossiers, briefings): 25s, not the 12s the rest get.
    signal: AbortSignal.timeout(body.action === "start" ? 45000 : body.action === "tool" ? 25000 : 12000),
  });
  const data = await response.json().catch(() => ({}));
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
export function VoiceEngine({ state, threadId, origin = "chat", nudge, cosmo = false, onClose }: {
  state: VoicePublicState; threadId: string | null; origin?: VoiceCall["origin"]; nudge?: string; cosmo?: boolean; onClose(): Promise<void>;
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
  /**
   * Spoken confirmation (Deepgram only: it can say a fixed line). One card at a time: Orbit reads
   * it back, and the window opens only once that read-back has been heard to the end.
   */
  const confirmRef = useRef<
    (ConfirmWindow & { messageId: string; actionId: string; line: string; heard: boolean; createdAt: number }) | null
  >(null);
  const lastUserStart = useRef(0);
  /** Cosmo's clicks and typing this call (capped in actions.ts), and whether a lookup turned them off. */
  const actionsUsed = useRef({ click: 0, type: 0 });
  const tainted = useRef(false);
  /** Anything happening in the call (speech either way, a tool, a mode change): for auto-sleep. */
  const lastActivity = useRef(0);
  /** The person said goodbye: end once Cosmo's goodbye has played (or after a few seconds). */
  const goodbye = useRef<number | null>(null);
  useEffect(() => () => {
    if (goodbye.current) window.clearTimeout(goodbye.current);
  }, []);
  /** The last email a spoken "send it" queued, while "undo" can still stop it. */
  const lastSend = useRef<{ sendId: string; until: number } | null>(null);
  const session = useRef<string | null>(null);
  const generation = useRef(0);
  const starting = useRef(false);
  /** Set once a session has started: later starts (reconnect, fallback) never replay the nudge. */
  const started = useRef(false);
  /** The call's thread; a Cosmo call learns it from the start response. */
  const thread = useRef(threadId);
  /**
   * Cosmo speaking up mid-call (Deepgram only: it needs `say`). The first may come a minute into
   * the call, never with the nudge the call opened with; `mayInterject` holds the rest.
   */
  const interject = useRef({ lastAt: 0, count: 0, lastPage: null as string | null, said: new Set(nudge ? [nudge] : []) });
  const pathname = usePathname();
  const { pulse } = useAppPulse();
  const latest = useRef({ pathname, pulse });
  useEffect(() => {
    latest.current = { pathname, pulse };
  }, [pathname, pulse]);

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
    if (!cosmo) return;
    const tick = window.setInterval(() => {
      const say = voiceControls.current?.say;
      const { pathname: page, pulse: livePulse } = latest.current;
      const it = interject.current;
      const now = Date.now();
      if (!say || !session.current || !livePulse || !it.lastAt) return;
      const next = allNudges(nudgeInput(livePulse), now).find((n) => n.interject && !it.said.has(n.id));
      if (!next?.interject) return;
      const w = confirmRef.current;
      const allowed = mayInterject({
        off: interjectionsOff(),
        mode: modeRef.current,
        confirmOpen: Boolean(w && (w.expiresAt ? now < w.expiresAt : now - w.createdAt < 20_000)),
        userSpeaking: now - lastUserStart.current < 4_000,
        now,
        lastAt: it.lastAt,
        count: it.count,
        page,
        lastPage: it.lastPage,
      });
      if (!allowed) return;
      interject.current = { lastAt: now, count: it.count + 1, lastPage: page, said: it.said.add(next.id) };
      say(next.interject);
    }, 5_000);
    return () => window.clearInterval(tick);
  }, [cosmo]);

  // Cosmo goes back to sleep after a quiet minute: nobody spoke, it said nothing, nothing pending.
  useEffect(() => {
    if (!cosmo) return;
    const tick = window.setInterval(() => {
      const now = Date.now();
      if (!session.current || !lastActivity.current || modeRef.current !== "listening" || confirmRef.current) return;
      if (now - lastActivity.current >= VOICE_IDLE_SLEEP_MS) void close();
    }, 5_000);
    return () => window.clearInterval(tick);
  }, [cosmo, close]);

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
          setVoiceCall({
            error: active.endsEarly
              ? "That's all the time with Cosmo there is for now."
              : "This voice session has reached its time limit. Start a new conversation.",
          });
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
    const runTool = async (tool: string, input: unknown): Promise<string> => {
      try {
        if (!current()) return JSON.stringify({ error: "Voice session ended" });
        const parsed = normalizeToolInput(input);
        if ("error" in parsed) return toolFailure(tool, "bad_input", parsed.error);
        // App control runs here, not on the server: the call lives in the layout, so it keeps
        // going on the page it opens. Only allowlisted pages; record pages need a real id.
        const args = parsed.args;
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
        if (tool === CLICK_TOOL || tool === TYPE_INTO_TOOL) {
          const kind = tool === CLICK_TOOL ? "click" : "type";
          const plan = planAction(kind, args.target, readScreen(), actionsUsed.current, tainted.current);
          if ("error" in plan) return JSON.stringify({ error: plan.error });
          let text: string | undefined;
          if (kind === "type") {
            const typed = cleanTyped(args.text);
            if ("error" in typed) return JSON.stringify({ error: typed.error });
            text = typed.text;
          }
          actionsUsed.current[kind]++;
          const done = await performSteps(plan.steps, text);
          if ("error" in done) return JSON.stringify({ error: done.error });
          appEvents.current.push(done.note);
          const screen = describeScreen(readScreen());
          lastScreen.current = screen;
          return JSON.stringify({ done: done.note, screen: screen ?? "The user is on a page Cosmo cannot describe." });
        }
        if (tool === OPEN_PAGE_TOOL) {
          const path = voicePagePath(args.page, args.id, args.filters);
          if (!path) return JSON.stringify({ error: "Unknown page, or that page needs a valid id from a lookup." });
          router.push(path);
          return JSON.stringify({ opened: path });
        }
        const response = await command({ action: "tool", sessionId: id, tool, input: args });
        if (!current()) return JSON.stringify({ error: "Voice session ended" });
        if (response.tainted) tainted.current = true;
        if (response.proposal) {
          setVoiceCall({ cards: [...getVoiceCall().cards, response.proposal] });
          offerSpokenConfirm(response.proposal);
        }
        return typeof response.result === "string" ? response.result : JSON.stringify({ error: "That lookup returned nothing." });
      } catch (err) {
        // Say what actually went wrong, so the model can fix its call or tell the user honestly.
        if (err instanceof VoiceRequestError) return toolFailure(tool, `http_${err.status}`, err.message);
        if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError"))
          return toolFailure(tool, "timeout", "That lookup took too long. Try a narrower question, or ask Orbit Chat.");
        return toolFailure(tool, "failed", "That lookup failed. Tell the user it didn't work; don't claim success.");
      }
    };
    const setCardStatus = (actionId: string, status: VoiceCard["action"]["status"]) =>
      setVoiceCall({ cards: getVoiceCall().cards.map((c) => (c.action.id === actionId ? { ...c, action: { ...c.action, status } } : c)) });
    /** A waiting card: Orbit reads it back (its own words) and listens for the phrase. */
    function offerSpokenConfirm(card: VoiceCard) {
      const say = voiceControls.current?.say;
      if (!say || card.action.status !== "proposed") return;
      const open = confirmRef.current;
      const now = Date.now();
      // One at a time; a window nobody answered stops blocking after it has closed.
      if (open && (open.expiresAt ? now < open.expiresAt : now - open.createdAt < 20_000)) return;
      const verb = confirmVerb({ tool: card.action.args.tool, destructive: Boolean(card.action.destructive) });
      const line = readBack(card.action.preview, verb);
      confirmRef.current = { messageId: card.messageId, actionId: card.action.id, verb, line, heard: false, opensAt: null, expiresAt: null, createdAt: now };
      say(line);
    }
    /** What the person said to an open window, done by the server and announced in Orbit's words. */
    async function act(kind: "confirm" | "dismiss", w: { messageId: string; actionId: string }) {
      const say = (text: string) => voiceControls.current?.say?.(text);
      try {
        const res = await command({ action: kind, sessionId: id, messageId: w.messageId, actionId: w.actionId });
        if (kind === "dismiss") {
          setCardStatus(w.actionId, "dismissed");
          appEvents.current.push("The user said cancel, so that change was not made.");
          return say("Okay, I won't.");
        }
        if (res.outcome === "sent") {
          setCardStatus(w.actionId, "done");
          lastSend.current = { sendId: res.sendId, until: Date.parse(res.sendAt) };
          appEvents.current.push(`The email was sent to ${res.to} (it can be undone for a few seconds).`);
          return say(`Sending to ${res.to}. Say "undo" in the next few seconds to stop it.`);
        }
        if (res.outcome === "done") {
          setCardStatus(w.actionId, "done");
          appEvents.current.push("The user said yes, and the change was saved.");
          return say("Done.");
        }
        if (res.outcome === "needs_mailbox")
          return say("I can't send from Orbit yet. Connect Gmail in Settings, under Integrations, then try again.");
        if (res.outcome === "no_address") return say("I don't have an email address for them. Add one on their page first.");
        return say(`That didn't work. ${res.reason ?? ""}`.trim());
      } catch {
        say("That didn't work. The card is still there if you want to try.");
      }
    }
    return {
      onReady: (driver) => {
        if (current()) voiceControls.current = driver;
      },
      onUserStarted: () => {
        // Not activity: any sound starts this (a TV, a café). Only real words keep a call awake.
        lastUserStart.current = Date.now();
      },
      onConnected: () => {
        if (current())
          void command({ action: "connected", sessionId: id }).catch(() => {
            if (current()) void stop("failed");
          });
      },
      onMode: (next) => {
        if (!current()) return;
        // The read-back has been heard to its end: only now may a spoken yes count.
        const w = confirmRef.current;
        if (w && w.heard && w.opensAt === null && modeRef.current === "speaking" && next === "listening") {
          w.opensAt = Date.now();
          w.expiresAt = w.opensAt + CONFIRM_WINDOW_MS;
        }
        // Cosmo's goodbye has played to its end: hang up.
        if (goodbye.current && modeRef.current === "speaking" && next === "listening") void close();
        modeRef.current = next;
        if (next === "speaking" || next === "thinking") lastActivity.current = Date.now();
        setVoiceCall(next !== "connecting" ? { mode: next, busy: false } : { mode: next });
      },
      onMessage: (source, text) => {
        if (!current() || !text.trim()) return;
        if (source === "ai" || hasWords(text)) lastActivity.current = Date.now();
        // Providers emit finalized turns here; recognition drafts never enter Chat history.
        const turn = { id: crypto.randomUUID(), source, text: text.slice(0, 4000), interrupted: false, revision: 1 };
        setLines([...transcript.current, turn]);
        persist(id!, turn);
        const w = confirmRef.current;
        // The agent's line IS the read-back: its audio is what must finish before listening.
        if (source === "ai") {
          if (w && !w.heard && text.trim() === w.line) w.heard = true;
          return;
        }
        const startedAt = lastUserStart.current || Date.now();
        // "Stop interrupting" holds on this device until they say it may again; the model answers it.
        if (cosmo && (isStopInterrupting(text) || isResumeInterrupting(text))) {
          const off = isStopInterrupting(text);
          setInterjectionsOff(off);
          appEvents.current.push(off ? "Cosmo will no longer speak up on its own." : "Cosmo may speak up again when something is time-sensitive.");
        }
        const send = lastSend.current;
        // "Undo" just after the window closed: say so, rather than leave the model to guess.
        if (send && Date.now() >= send.until && Date.now() - send.until < 120_000 && /\b(undo|unsend)\b|\btake it back\b/.test(norm(text))) {
          lastSend.current = null;
          appEvents.current.push("The user said undo, but the email had already gone.");
          voiceControls.current?.say?.("Too late, it already went.");
          return;
        }
        if (send && Date.now() < send.until && isUndo(text)) {
          lastSend.current = null;
          void command({ action: "undo_send", sessionId: id, sendId: send.sendId })
            .then((res: { result: string }) => {
              const stopped = res.result === "canceled";
              appEvents.current.push(stopped ? "The user said undo: the email was stopped." : "The email had already gone.");
              voiceControls.current?.say?.(stopped ? "Stopped. It won't be sent." : "Too late, it already went.");
            })
            .catch(() => {});
          return;
        }
        const leaving = () => {
          if (!isGoodbye(text) || goodbye.current) return;
          appEvents.current.push("The user said goodbye; the call ends after your reply.");
          goodbye.current = window.setTimeout(() => void close(), 8_000);
        };
        if (!w) return leaving();
        const judgement = judgeUtterance(w, text, startedAt);
        if (judgement === "early") return;
        if (judgement === "reprompt") {
          // A bare "yes" to a send: ask once for the verb. The window reopens only after this
          // line has played, like the read-back, so its own "send it" can't be heard as a yes.
          const line = repromptLine(w.verb);
          Object.assign(w, { reprompted: true, line, heard: false, opensAt: null, expiresAt: null, createdAt: Date.now() });
          voiceControls.current?.say?.(line);
          return;
        }
        confirmRef.current = null;
        if (judgement === "confirm") void act("confirm", w);
        else if (judgement === "cancel") void act("dismiss", w);
        else leaving();
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
        lastActivity.current = Date.now();
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
  }, [active, stop, persist, router, meeting, setTheme, askChat, cosmo, close]);

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
    onUserStarted: () => eventsRef.current.onUserStarted?.(),
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
        // Only the first start opens with the nudge; a reconnect or fallback greets plainly.
        nudge: started.current ? undefined : nudge,
      });
      if (!alive.current || attempt !== generation.current) {
        await command({ action: "end", sessionId: response.sessionId }).catch(() => {});
        return;
      }
      session.current = response.sessionId;
      started.current = true;
      lastActivity.current = Date.now();
      // The minute before the first interjection counts from here: the opener has the floor.
      if (!interject.current.lastAt) interject.current.lastAt = Date.now();
      thread.current = response.threadId;
      setCallThread(response.threadId);
      setActive(response);
      setVoiceCall({
        active: true,
        provider: response.credentials.provider,
        endsAt: Date.parse(response.expiresAt),
        endsEarly: Boolean(response.endsEarly),
      });
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
