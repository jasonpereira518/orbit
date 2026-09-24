"use client";

/**
 * The live half of voice dictation: binds `dictationReducer` to a real `SpeechRecognition`.
 *
 * The hook emits strings and nothing else — it never reads or writes an element. That is
 * what lets the /chat `<textarea>` and, later, the ask bar's `<input>` share it, and it
 * keeps every DOM concern (caret, anchor, splice) in the caller where it belongs.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useMotionValue, type MotionValue } from "motion/react";
import {
  MAX_SESSION_MS,
  SEGMENT_PAUSE_MS,
  dictationReducer,
  initialMachine,
  punctuateSegment,
  tidyTranscript,
  type DictationEffect,
  type DictationEndReason,
  type DictationErrorCode,
  type DictationEvent,
  type DictationState,
  type Machine,
} from "@/lib/dictation";
import { EMPTY_FOLD, foldResults, type FoldState } from "@/lib/dictation-fold";
import { openDeepgramLive, type LiveHandle, type LiveResult } from "@/lib/deepgram-live";
import { listenParams } from "@/lib/deepgram-params";
import { TARGET_SAMPLE_RATE, createDownsampler } from "@/lib/voice-recording";

/** What `POST /api/speech/token` hands back on success. See Task 7's route. */
type SpeechToken = { accessToken: string; keyterms?: string[]; tag?: string | null };

const DEEPGRAM_WORKLET_URL = "/orbit-pcm-worklet.js";
const DEEPGRAM_WORKLET_NAME = "orbit-pcm-recorder";

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Whether this browser can carry mic audio to Deepgram at all. Checked before spending a
 * token-fetch round trip on a browser that could never open the socket anyway.
 */
function canCaptureForDeepgram(): boolean {
  if (typeof window === "undefined") return false;
  if (!getAudioContextCtor()) return false;
  if (typeof AudioWorkletNode === "undefined") return false;
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * Best-effort usage report for one Deepgram session, fired as the socket closes.
 *
 * `sendBeacon` because this runs from `stop-recognition`/`abort-recognition`, which can
 * fire as the user navigates away — the same reasoning as the traffic beacon in
 * `pageview-beacon.tsx`. A dropped beacon under-counts one session, which is the right way
 * for this to fail — and the connection is tagged `shortform:<userId>`, so the nightly
 * reconciliation job sees the seconds Deepgram billed even when no beacon arrives.
 *
 * Takes the whole session's billed milliseconds, NOT one socket's open time: a session that
 * reconnected after a drop has streamed under two or three sockets, and reporting only the
 * last one's lifetime under-counted every dropped stretch. `dgBilledMsRef` banks the earlier
 * ones (see `bankSpeechUsage`).
 */
function reportSpeechUsage(billedMs: number) {
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return;
  const seconds = Math.max(0, Math.round(billedMs / 1000));
  if (!seconds) return;
  try {
    navigator.sendBeacon(
      "/api/speech/usage",
      new Blob([JSON.stringify({ seconds })], { type: "application/json" }),
    );
  } catch {
    /* best effort — losing one session's usage report is not worth surfacing */
  }
}

// ── Types the DOM lib is missing ──────────────────────────────────────────────────────
// TypeScript 5.9's lib.dom.d.ts ships SpeechRecognitionResult, -ResultList and
// -Alternative but not these three. Declared module-locally rather than in a global
// .d.ts, so we never shadow the ones that do exist.

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onaudiostart: ((this: SpeechRecognitionLike, ev: Event) => void) | null;
  onspeechstart: ((this: SpeechRecognitionLike, ev: Event) => void) | null;
  onspeechend: ((this: SpeechRecognitionLike, ev: Event) => void) | null;
  onsoundstart: ((this: SpeechRecognitionLike, ev: Event) => void) | null;
  onresult: ((this: SpeechRecognitionLike, ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((this: SpeechRecognitionLike, ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((this: SpeechRecognitionLike, ev: Event) => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
  /** Dev-only seam: the only way to drive error paths without unplugging hardware. */
  __orbitSpeechRecognition?: SpeechRecognitionCtor;
};

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as SpeechWindow;
  if (process.env.NODE_ENV !== "production" && w.__orbitSpeechRecognition) {
    return w.__orbitSpeechRecognition;
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

let cachedSupport: boolean | null = null;

/** Constructing does not prompt for permission, so this is a safe probe. */
export function isDictationSupported(): boolean {
  if (cachedSupport !== null) return cachedSupport;
  const Ctor = getRecognitionCtor();
  if (!Ctor) return false;
  try {
    new Ctor();
    cachedSupport = true;
  } catch {
    cachedSupport = false;
  }
  return cachedSupport;
}

/**
 * Whether dictation can work in this browser AT ALL — the union, not the browser engine
 * alone. Deepgram is the primary path now, and it needs nothing this browser wouldn't
 * already need for `use-voice-recorder.ts` (`AudioContext` + `AudioWorklet` +
 * `getUserMedia`), not `SpeechRecognition`. A browser with only one of the two — Safari
 * missing the worklet APIs, or Firefox without `SpeechRecognition` — still gets a mic
 * button; only a browser with NEITHER path hides it.
 */
function dictationCapable(): boolean {
  return canCaptureForDeepgram() || isDictationSupported();
}

const NO_SUPPORT_CHANGES = () => () => {};

// ── Energy ────────────────────────────────────────────────────────────────────────────

/**
 * Web Speech exposes no amplitude, and opening a second getUserMedia stream just to draw
 * a waveform costs a second permission surface, a second capture that is unreliable on
 * Safari/iOS, and two AGC loops fighting each other — for a decoration.
 *
 * So the level is inferred from what the recogniser already tells us: its own voice
 * activity as a floor, and the rate at which transcript arrives as the impulse. It swells
 * on a burst of words and decays through a pause, which at 44px is the whole job.
 */
const ENERGY_DECAY = 0.9;
const ENERGY_PER_EVENT = 0.3;
const ENERGY_PER_CHAR = 0.05;
const ENERGY_CHAR_CAP = 0.35;
const FLOOR_SPEAKING = 0.18;
const FLOOR_QUIET = 0.04;

// ── Hook ──────────────────────────────────────────────────────────────────────────────

export type UseDictationOptions = {
  lang?: string;
  /** Fired before any text arrives, so the caller can anchor at the current caret. */
  onSessionStart?: () => void;
  /**
   * The ENTIRE tidied span for this session, every time — cumulative across interim
   * revisions and across the engine's internal restarts. Replace, never append.
   */
  onTranscript: (
    span: string,
    meta: {
      hasInterim: boolean;
      /**
       * Index within `span` where the not-yet-final tail begins, so the caller can render
       * it differently. Derived by tidying with and without the interim text and taking
       * the common prefix — tidying can change lengths, so a raw character count would
       * drift.
       */
      interimStart: number;
    },
  ) => void;
  onSessionEnd?: (reason: DictationEndReason) => void;
  onEffect?: (effect: DictationEffect) => void;
};

export type DictationHandle = {
  state: DictationState;
  supported: boolean;
  listening: boolean;
  error: DictationErrorCode | null;
  /** 0..1. A MotionValue: 60fps React state here would re-render the whole thread. */
  level: MotionValue<number>;
  /** Which engine served the current or most recent session. Null before the first start. */
  engine: "deepgram" | "browser" | null;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  toggle: () => void;
};

export function useDictation(options: UseDictationOptions): DictationHandle {
  const { lang, onSessionStart, onTranscript, onSessionEnd, onEffect } = options;

  // Options are read from live refs so the recogniser's handlers, bound once, never
  // capture a stale closure.
  const cb = useRef({ onSessionStart, onTranscript, onSessionEnd, onEffect });
  useLayoutEffect(() => {
    cb.current = { onSessionStart, onTranscript, onSessionEnd, onEffect };
  });

  // Whether ANY engine is usable never changes after load, and must read false on the
  // server so hydration matches. The button appears a frame later; reserving space for it
  // instead would leave a permanent hole on a browser with neither path.
  const supported = useSyncExternalStore(
    NO_SUPPORT_CHANGES,
    dictationCapable,
    () => false,
  );

  // The machine always starts idle; `supported` is layered on at the bottom. That keeps
  // feature detection out of the reducer, which still owns the `unsupported` latch for a
  // browser whose constructor exists but whose engine does not.
  const [machine, setMachine] = useState<Machine>(() => initialMachine(true));
  // Kept current by `dispatch` itself, so two dispatches in one tick still compose.
  const machineRef = useRef(machine);

  // Mirrors `engineRef` into a render-visible value for the returned handle. `engineRef`
  // itself stays the source of truth the effect switch branches on — refs are safe to read
  // from an event handler or effect, just not during render, which is all `engine` state is
  // for.
  const [engine, setEngineState] = useState<"deepgram" | "browser" | null>(null);

  const level = useMotionValue(0);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  /** Which engine is (or was last) driving a session. Null until `start-recognition` decides. */
  const engineRef = useRef<"deepgram" | "browser" | null>(null);
  // ── Deepgram-engine state. Parallel to recRef/baseCommittedRef above, but Deepgram never
  // replays a growing results list the way SpeechRecognition does, so it gets its own
  // bookkeeping rather than reusing the browser engine's.
  const dgHandleRef = useRef<LiveHandle | null>(null);
  const dgFoldRef = useRef<FoldState>(EMPTY_FOLD);
  const dgStreamRef = useRef<MediaStream | null>(null);
  const dgCtxRef = useRef<AudioContext | null>(null);
  const dgNodeRef = useRef<AudioWorkletNode | null>(null);
  const dgSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  /** Set right before we close the socket ourselves, so our own close isn't read as a drop. */
  const dgSuppressCloseRef = useRef(false);
  /**
   * Bumped every time `startDeepgramEngine` begins a NEW connection attempt — including a
   * mid-session reconnect after a drop, which keeps the same `sessionId`. A closure from an
   * earlier attempt (most importantly a dead socket's belated `onclose`, which can arrive
   * after we've already torn it down and dialed a new one) checks this alongside
   * `sessionId`; `sessionId` alone can't tell two connections in the SAME session apart.
   */
  const dgGenerationRef = useRef(0);
  /**
   * Milliseconds already streamed by EARLIER sockets in this session — banked when a dropped
   * connection is replaced, zeroed by a full teardown (which is what ends a session). Without
   * it, a session that dropped and reconnected reported only the last socket's open time and
   * Orbit paid for the rest unmetered.
   */
  const dgBilledMsRef = useRef(0);

  /** The one place that sets `engineRef` — keeps the render-visible `engine` state in sync. */
  const setEngine = useCallback((next: "deepgram" | "browser" | null) => {
    engineRef.current = next;
    setEngineState(next);
  }, []);

  const sessionIdRef = useRef(0);
  /** Finals from PREVIOUS recognition instances, i.e. across internal restarts. */
  const baseCommittedRef = useRef("");
  const lastFinalsRef = useRef("");
  /** The last span handed to the caller — what a seal must commit, interim tail included. */
  const lastSpanRef = useRef("");
  const spanLengthRef = useRef(0);
  const speakingRef = useRef(false);
  const energyRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endReasonRef = useRef<DictationEndReason>("user");

  const dispatchRef = useRef<(e: DictationEvent) => void>(() => {});

  const clearTimers = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    silenceTimerRef.current = null;
    maxTimerRef.current = null;
  }, []);

  const stopEnergyLoop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    energyRef.current = 0;
    speakingRef.current = false;
    level.set(0);
  }, [level]);

  const startEnergyLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    const tick = () => {
      energyRef.current *= ENERGY_DECAY;
      const floor = speakingRef.current ? FLOOR_SPEAKING : FLOOR_QUIET;
      level.set(Math.min(1, Math.max(floor, energyRef.current)));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [level]);

  /**
   * Restart the sentence-boundary countdown.
   *
   * This used to end the session. It now only closes a sentence — pausing to think is the
   * single most common thing a person does mid-question, and the mic must survive it.
   */
  const armSegmentPause = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      dispatchRef.current({ t: "segment" });
    }, SEGMENT_PAUSE_MS);
  }, []);

  /** Detach every handler before touching the engine, so a dying instance stays quiet. */
  const teardownRecognition = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return null;
    rec.onaudiostart = null;
    rec.onspeechstart = null;
    rec.onspeechend = null;
    rec.onsoundstart = null;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    recRef.current = null;
    return rec;
  }, []);

  /** Release the mic tap and worklet graph feeding Deepgram. Does NOT touch the socket. */
  const teardownDeepgramCapture = useCallback(() => {
    const node = dgNodeRef.current;
    if (node) {
      try {
        node.port.postMessage("stop");
      } catch {
        // The worklet is already gone; the disconnect below is what matters.
      }
      node.port.onmessage = null;
      node.disconnect();
    }
    dgNodeRef.current = null;

    dgSourceRef.current?.disconnect();
    dgSourceRef.current = null;

    for (const track of dgStreamRef.current?.getTracks() ?? []) track.stop();
    dgStreamRef.current = null;

    const ctx = dgCtxRef.current;
    dgCtxRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
  }, []);

  /**
   * Close the socket (idempotent — safe whether it's still live, already dropped, or
   * already closed by the caller) and release the mic graph. Does NOT touch this session's
   * fold state — a mid-session reconnect after a drop needs `dgFoldRef` to survive it, so
   * that call site uses this directly rather than `teardownDeepgram`.
   */
  const teardownDeepgramConnection = useCallback(() => {
    const handle = dgHandleRef.current;
    dgHandleRef.current = null;
    if (handle) {
      try {
        handle.close();
      } catch {
        /* already gone */
      }
    }
    teardownDeepgramCapture();
  }, [teardownDeepgramCapture]);

  /**
   * Full Deepgram teardown: the socket, the mic graph, this session's fold state — and the
   * billed-milliseconds bank, because a full teardown is what ends a session. Every path that
   * calls this reports usage FIRST (see `flushSpeechUsage`); a reconnect deliberately uses
   * `teardownDeepgramConnection` instead, so the bank survives it.
   */
  const teardownDeepgram = useCallback(() => {
    teardownDeepgramConnection();
    dgFoldRef.current = EMPTY_FOLD;
    dgSuppressCloseRef.current = false;
    dgBilledMsRef.current = 0;
  }, [teardownDeepgramConnection]);

  /** A connection is being replaced: keep the seconds it streamed. */
  const bankSpeechUsage = useCallback(() => {
    const handle = dgHandleRef.current;
    if (handle) dgBilledMsRef.current += Math.max(0, Date.now() - handle.openedAt);
  }, []);

  /**
   * Report everything this session streamed and empty the bank, so a second call on another
   * exit path cannot send the same seconds twice. Takes the handle rather than reading the
   * ref, because a caller that awaited `handle.finish()` may find the ref already cleared —
   * and is called with `null` on purpose when only banked time is left.
   */
  const flushSpeechUsage = useCallback((handle: LiveHandle | null) => {
    const open = handle ? Math.max(0, Date.now() - handle.openedAt) : 0;
    const total = dgBilledMsRef.current + open;
    dgBilledMsRef.current = 0;
    reportSpeechUsage(total);
  }, []);

  const buildRecognition = useCallback(
    (sessionId: number): SpeechRecognitionLike | null => {
      const Ctor = getRecognitionCtor();
      if (!Ctor) return null;
      let rec: SpeechRecognitionLike;
      try {
        rec = new Ctor();
      } catch {
        return null;
      }

      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.lang =
        lang ??
        (typeof navigator !== "undefined" && navigator.language
          ? navigator.language
          : "en-US");

      /** Every handler drops out if a newer session has begun — this kills the send race. */
      const stale = () => sessionIdRef.current !== sessionId;

      rec.onaudiostart = () => {
        if (stale()) return;
        dispatchRef.current({ t: "audiostart" });
      };
      rec.onsoundstart = () => {
        if (stale()) return;
        armSegmentPause();
      };
      rec.onspeechstart = () => {
        if (stale()) return;
        speakingRef.current = true;
        armSegmentPause();
      };
      rec.onspeechend = () => {
        if (stale()) return;
        speakingRef.current = false;
      };

      rec.onresult = (event) => {
        if (stale()) return;

        // Recomputed from the full list every time: Chrome and Safari disagree on
        // resultIndex, and Safari re-emits earlier finals. Appending from resultIndex
        // duplicates whole sentences.
        let finals = "";
        let interim = "";
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0]?.transcript ?? "";
          if (result.isFinal) finals += text;
          else interim += text;
        }
        lastFinalsRef.current = finals;

        const committed = tidyTranscript(baseCommittedRef.current + finals);
        const span = interim
          ? tidyTranscript(baseCommittedRef.current + finals + interim)
          : committed;
        let interimStart = 0;
        while (
          interimStart < committed.length &&
          committed[interimStart] === span[interimStart]
        ) {
          interimStart++;
        }
        lastSpanRef.current = span;
        const grew = span.length - spanLengthRef.current;
        spanLengthRef.current = span.length;

        energyRef.current = Math.min(
          1,
          energyRef.current +
            ENERGY_PER_EVENT +
            Math.min(ENERGY_CHAR_CAP, Math.max(0, grew) * ENERGY_PER_CHAR),
        );

        armSegmentPause();
        dispatchRef.current({ t: "result" });
        cb.current.onTranscript(span, {
          hasInterim: interim.length > 0,
          interimStart,
        });
      };

      rec.onerror = (event) => {
        if (stale()) return;
        dispatchRef.current({ t: "error", code: event.error, now: Date.now() });
      };

      rec.onend = () => {
        if (stale()) return;
        dispatchRef.current({ t: "end", now: Date.now() });
      };

      return rec;
    },
    [armSegmentPause, lang],
  );

  /**
   * True once this session should give up trying to start an engine — either a newer
   * session has begun, or THIS session was told to stop/cancel before it got anywhere.
   *
   * The second case matters because `stop-recognition`/`abort-recognition` already ran
   * (synchronously, at dispatch time) and found no engine to act on yet — `dgHandleRef` and
   * `recRef` are both still null. Nothing else will ever move the machine out of
   * "listening"/"requesting", so this dispatches the `end` that finishes it. Safe to call
   * more than once: dispatching `end` onto an already-idle machine is a no-op in the
   * reducer.
   */
  const startAbandoned = useCallback((sessionId: number, generation?: number): boolean => {
    if (sessionIdRef.current !== sessionId) return true;
    // A NEWER connection attempt within this same session has already started (a
    // reconnect after a drop) — this one is a leftover, and the newer attempt owns the
    // session now. No dispatch: that would be reporting on a session the newer attempt is
    // handling.
    if (generation !== undefined && dgGenerationRef.current !== generation) return true;
    if (!machineRef.current.intentionalStop) return false;
    dispatchRef.current({ t: "end", now: Date.now() });
    return true;
  }, []);

  /** The browser `SpeechRecognition` path — used directly, or as Deepgram's fallback. */
  const startBrowserRecognition = useCallback(
    (sessionId: number) => {
      if (startAbandoned(sessionId)) return;
      setEngine("browser");
      const rec = buildRecognition(sessionId);
      if (!rec) {
        // Reachable now that `supported` also covers a Deepgram-only browser: Deepgram
        // failed for this session AND this browser has no `SpeechRecognition` to fall
        // back to. Surface it rather than leaving the machine stuck in "requesting"
        // forever — the button would otherwise spin with nothing left to try.
        dispatchRef.current({ t: "error", code: "audio-capture", now: Date.now() });
        return;
      }
      recRef.current = rec;
      try {
        rec.start();
      } catch {
        // Chrome throws InvalidStateError if start() races a live instance.
        return;
      }
      startEnergyLoop();
      armSegmentPause();
    },
    [armSegmentPause, buildRecognition, setEngine, startAbandoned, startEnergyLoop],
  );

  /**
   * Fold one Deepgram result into the session's running transcript and hand it to the
   * caller exactly the way the browser engine's `onresult` does: the whole tidied span,
   * plus where its not-yet-final tail begins.
   */
  const handleDeepgramResult = useCallback(
    (result: LiveResult) => {
      const next = foldResults(dgFoldRef.current, result);
      dgFoldRef.current = next;

      const committed = tidyTranscript(next.committed);
      const span = next.interim
        ? tidyTranscript(next.committed ? `${next.committed} ${next.interim}` : next.interim)
        : committed;
      let interimStart = 0;
      while (interimStart < committed.length && committed[interimStart] === span[interimStart]) {
        interimStart++;
      }
      lastSpanRef.current = span;
      const grew = span.length - spanLengthRef.current;
      spanLengthRef.current = span.length;

      energyRef.current = Math.min(
        1,
        energyRef.current +
          ENERGY_PER_EVENT +
          Math.min(ENERGY_CHAR_CAP, Math.max(0, grew) * ENERGY_PER_CHAR),
      );

      armSegmentPause();
      dispatchRef.current({ t: "result" });
      cb.current.onTranscript(span, {
        hasInterim: next.interim.length > 0,
        interimStart,
      });
    },
    [armSegmentPause],
  );

  /**
   * The Deepgram path: mint a token, tap the mic through the same worklet + downsampler
   * `use-voice-recorder.ts` uses, and open the live socket. Throws on any failure — no
   * token, no quota, no mic, no socket — so the caller can fall back to the browser engine.
   */
  const startDeepgramEngine = useCallback(
    async (sessionId: number) => {
      // Every NEW connection attempt — the first one, and every reconnect after a drop
      // within the same session — gets its own generation. A closure from an earlier one
      // (most importantly a dead socket's belated `onclose`, which can still arrive after
      // we've already torn it down and dialed a new one) checks this and backs off, since
      // `sessionId` alone is the same for both and can't tell them apart.
      const generation = ++dgGenerationRef.current;
      const abandoned = (): boolean => startAbandoned(sessionId, generation);

      if (!canCaptureForDeepgram()) throw new Error("deepgram-capture-unsupported");

      const res = await fetch("/api/speech/token", { method: "POST" });
      if (abandoned()) return;
      if (!res.ok) throw new Error(`speech-token-${res.status}`);
      const token = (await res.json()) as SpeechToken;
      if (abandoned()) return;
      if (!token?.accessToken) throw new Error("speech-token-empty");

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (abandoned()) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      const Ctor = getAudioContextCtor();
      if (!Ctor) {
        for (const track of stream.getTracks()) track.stop();
        throw new Error("deepgram-no-audiocontext");
      }
      // Asking for 16 kHz saves the resample when it is honoured — `createDownsampler`
      // copes either way by reading `ctx.sampleRate` back rather than assuming.
      const ctx = new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
      // Autoplay policy can hand back a suspended context even inside a click handler; not
      // awaited, the same as `use-voice-recorder.ts` — the graph runs once resumed and
      // frames flow either way.
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});

      try {
        await ctx.audioWorklet.addModule(DEEPGRAM_WORKLET_URL);
      } catch (err) {
        for (const track of stream.getTracks()) track.stop();
        void ctx.close().catch(() => {});
        throw err;
      }
      if (abandoned()) {
        for (const track of stream.getTracks()) track.stop();
        void ctx.close().catch(() => {});
        return;
      }

      const stale = () => sessionIdRef.current !== sessionId || dgGenerationRef.current !== generation;
      const handle = await openDeepgramLive({
        token: token.accessToken,
        // Tagged, so the nightly reconciliation job can see this connection at all: the
        // seconds below are self-reported by a beacon that a crashed tab never sends.
        params: listenParams({ live: true, keyterms: token.keyterms, tag: token.tag }),
        onResult: (result) => {
          if (stale()) return;
          handleDeepgramResult(result);
        },
        // A live-session close/error is a dropped connection, not a start-up failure. The
        // browser engine's `onerror` is always followed by its own `onend` — a Web Speech
        // API guarantee — which is what drives `restart-recognition` and the storm-retry
        // logic in the reducer. Deepgram's socket has no equivalent second event, so both
        // handlers supply it themselves: `error` first (flips `networkRetried`, or on the
        // second drop goes straight to `state: "error"`), then `end` (runs the restart —
        // or, once already in `state: "error"`, is a no-op). Without the `end`, the first
        // drop would flip `networkRetried` and then just sit in "listening" forever, since
        // nothing else ends this session for a dropped socket.
        // Neither fires at all if we are the ones who closed it (`stop-recognition` /
        // `abort-recognition` / a reconnect already set `dgSuppressCloseRef` first).
        onClose: () => {
          if (stale() || dgSuppressCloseRef.current) return;
          dispatchRef.current({ t: "error", code: "network", now: Date.now() });
          dispatchRef.current({ t: "end", now: Date.now() });
        },
        onError: () => {
          if (stale() || dgSuppressCloseRef.current) return;
          dispatchRef.current({ t: "error", code: "network", now: Date.now() });
          dispatchRef.current({ t: "end", now: Date.now() });
        },
      });

      if (abandoned()) {
        handle.close();
        for (const track of stream.getTracks()) track.stop();
        void ctx.close().catch(() => {});
        return;
      }

      const node = new AudioWorkletNode(ctx, DEEPGRAM_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
      });
      const source = ctx.createMediaStreamSource(stream);
      source.connect(node);
      // Deliberately NOT connected to `ctx.destination` — same reasoning as the recorder.

      const downsample = createDownsampler(ctx.sampleRate);
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (stale()) return;
        const frame = event.data;
        if (!frame || frame.length === 0) return;
        const pcm = downsample(frame);
        if (pcm.length) handle.send(pcm);
      };

      setEngine("deepgram");
      dgHandleRef.current = handle;
      dgStreamRef.current = stream;
      dgCtxRef.current = ctx;
      dgNodeRef.current = node;
      dgSourceRef.current = source;

      dispatchRef.current({ t: "audiostart" });
      startEnergyLoop();
      armSegmentPause();
    },
    [armSegmentPause, handleDeepgramResult, setEngine, startAbandoned, startEnergyLoop],
  );

  /** Decide Deepgram vs the browser engine for this session, and start whichever works. */
  const startEngine = useCallback(
    async (sessionId: number) => {
      try {
        await startDeepgramEngine(sessionId);
        return;
      } catch {
        // Any failure to get Deepgram running — no token, no quota, Deepgram off, no
        // socket, no mic, no capture APIs — falls back to today's browser engine. Its own
        // `onerror` already knows how to report a real permission denial or missing mic,
        // so there is no reason to special-case those here rather than just letting it try.
      }
      startBrowserRecognition(sessionId);
    },
    [startBrowserRecognition, startDeepgramEngine],
  );

  const runEffects = useCallback(
    (effects: DictationEffect[], sessionId: number) => {
      for (const effect of effects) {
        cb.current.onEffect?.(effect);
        switch (effect) {
          case "start-recognition": {
            baseCommittedRef.current = "";
            lastFinalsRef.current = "";
            lastSpanRef.current = "";
            spanLengthRef.current = 0;
            endReasonRef.current = "user";
            setEngine(null);
            dgFoldRef.current = EMPTY_FOLD;
            cb.current.onSessionStart?.();

            if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
            maxTimerRef.current = setTimeout(() => {
              endReasonRef.current = "timeout";
              dispatchRef.current({ t: "stop" });
            }, MAX_SESSION_MS);

            // Deepgram first, the browser engine as its fallback — see `startEngine`. Both
            // paths call `armSegmentPause`/`startEnergyLoop` themselves once they actually
            // have an engine running, which for Deepgram is after an async token fetch and
            // mic handshake rather than in this same tick.
            void startEngine(sessionId);
            break;
          }

          case "seal-segment": {
            // Punctuate everything said so far and make it the new committed base. Writing
            // it into `baseCommittedRef` is what stops a later result from resurrecting the
            // un-punctuated version.
            // Seal what the caller is actually showing, not just the finals: if the engine
            // has not finalised the tail yet, committing finals alone would drop words the
            // user can see on screen.
            const sealed = punctuateSegment(lastSpanRef.current);
            // Trailing space so the next utterance starts a new sentence, not a new word.
            const nextBase = sealed ? sealed + " " : "";
            // Nothing new since the last seal. Bail BEFORE restarting the engine — otherwise
            // sitting silent would seal, and therefore restart, every SEGMENT_PAUSE_MS.
            if (!sealed || nextBase === baseCommittedRef.current) break;
            baseCommittedRef.current = nextBase;
            lastFinalsRef.current = "";
            lastSpanRef.current = nextBase;

            if (engineRef.current === "deepgram") {
              // Unlike SpeechRecognition, Deepgram never replays old finals — every message
              // is new — so resetting our own fold state is enough to make the seal stick.
              // No socket restart needed.
              dgFoldRef.current = { committed: sealed, interim: "" };
              cb.current.onTranscript(nextBase, {
                hasInterim: false,
                interimStart: nextBase.length,
              });
              break;
            }

            // The restart is load-bearing, not incidental: it clears the engine's own
            // results list, which still holds the raw finals we just rewrote. Without it
            // the next event would re-append them after the sealed copy.
            teardownRecognition();
            const resealed = buildRecognition(sessionId);
            if (!resealed) break;
            recRef.current = resealed;
            try {
              resealed.start();
            } catch {
              break;
            }
            cb.current.onTranscript(baseCommittedRef.current, {
              hasInterim: false,
              interimStart: baseCommittedRef.current.length,
            });
            // Deliberately NOT re-arming: the next pause countdown starts when the user
            // speaks again. Re-arming here would seal-and-restart forever during silence.
            break;
          }

          case "restart-recognition": {
            if (engineRef.current === "deepgram") {
              // A dropped Deepgram connection needs a fresh grant token and a fresh
              // socket, not a replay — there is no in-process instance to rebuild the way
              // the browser branch below does. Whatever is already committed lives in
              // `dgFoldRef.current.committed`; keep it (this is the ONE place that reuses
              // `dgFoldRef` across a reconnect rather than resetting it) and drop any
              // dangling interim, the same as the browser branch folds its own finals
              // forward instead of discarding them.
              dgFoldRef.current = { committed: dgFoldRef.current.committed, interim: "" };
              // The dropped socket's own seconds, before its handle goes: they were streamed
              // and billed, and the beacon at the end of the session only knows about the
              // socket that is open when it fires.
              bankSpeechUsage();
              teardownDeepgramConnection();
              void startDeepgramEngine(sessionId).catch(() => {
                // The reconnect itself failed — no token, no mic, no socket. Treat it
                // exactly like another drop: `networkRetried` is already true from the
                // first one (this only runs after a first drop already retried), so this
                // goes straight to the reducer's existing "give up and toast" path rather
                // than silently falling back to the browser engine, which would start its
                // own transcript tracking from empty and lose everything committed here.
                if (!startAbandoned(sessionId)) {
                  dispatchRef.current({ t: "error", code: "network", now: Date.now() });
                }
              });
              break;
            }
            // Fold this instance's finals forward; the new one starts an empty list.
            baseCommittedRef.current += lastFinalsRef.current;
            lastFinalsRef.current = "";
            teardownRecognition();
            const rec = buildRecognition(sessionId);
            if (!rec) break;
            recRef.current = rec;
            try {
              rec.start();
            } catch {
              break;
            }
            armSegmentPause();
            break;
          }

          case "stop-recognition": {
            if (engineRef.current === "deepgram") {
              const handle = dgHandleRef.current;
              if (!handle) {
                // Stopped before the socket ever opened (still mid token-fetch/mic-handshake
                // when the user let go). `startDeepgramEngine`'s own `startAbandoned` checks
                // will unwind whatever it managed to acquire and dispatch `end` themselves.
                break;
              }

              // Set BEFORE finish() — it triggers the socket's own onclose (Metadata after
              // Finalize/CloseStream, or the 5s fallback), which must not read a deliberate
              // stop as a dropped connection. `teardownDeepgram` below closes the socket
              // for real; this only suppresses that close's own event.
              dgSuppressCloseRef.current = true;
              void (async () => {
                try {
                  await handle.finish();
                } catch {
                  /* best effort — still close and report what we have below */
                }
                flushSpeechUsage(handle);
                teardownDeepgram();
                if (sessionIdRef.current === sessionId) {
                  dispatchRef.current({ t: "end", now: Date.now() });
                }
              })();
              break;
            }
            // stop(), not abort(): the engine flushes its trailing words on the way out.
            try {
              recRef.current?.stop();
            } catch {
              /* already stopped */
            }
            break;
          }

          case "abort-recognition": {
            clearTimers();
            stopEnergyLoop();
            if (engineRef.current === "deepgram") {
              const handle = dgHandleRef.current;
              dgSuppressCloseRef.current = true;
              flushSpeechUsage(handle);
              teardownDeepgram();
              break;
            }
            const rec = teardownRecognition();
            try {
              rec?.abort();
            } catch {
              /* already gone */
            }
            break;
          }

          case "toast-denied":
          case "toast-no-microphone":
          case "toast-network":
            // Surfaced by the caller through onEffect; the hook stays UI-free.
            break;
        }
      }
    },
    [
      armSegmentPause,
      bankSpeechUsage,
      buildRecognition,
      clearTimers,
      flushSpeechUsage,
      setEngine,
      startAbandoned,
      startDeepgramEngine,
      startEngine,
      stopEnergyLoop,
      teardownDeepgram,
      teardownDeepgramConnection,
      teardownRecognition,
    ],
  );

  const dispatch = useCallback(
    (event: DictationEvent) => {
      const before = machineRef.current;
      const { machine: next, effects } = dictationReducer(before, event);

      // The session id must be live before any effect runs, so handlers bound by
      // start-recognition compare against the right one.
      sessionIdRef.current = next.sessionId;
      machineRef.current = next;
      setMachine(next);

      runEffects(effects, next.sessionId);

      const wasActive = before.state === "listening" || before.state === "requesting";
      const nowActive = next.state === "listening" || next.state === "requesting";
      if (wasActive && !nowActive) {
        clearTimers();
        stopEnergyLoop();
        teardownRecognition();
        // A safety net, not the normal path: a Deepgram `network` error that exhausts its
        // one retry reaches `state: "error"` straight from the reducer, with no
        // `abort-recognition`/`stop-recognition` effect for `runEffects` to act on — the
        // socket is already gone by the time that error was dispatched, but the mic capture
        // graph and any still-open handle are not. Report what this (possibly reconnected)
        // session streamed before closing it; `teardownDeepgram` is idempotent, so this is
        // a no-op on every path that already cleaned up for itself.
        flushSpeechUsage(dgHandleRef.current);
        teardownDeepgram();
        const reason: DictationEndReason =
          next.state === "error"
            ? "error"
            : event.t === "cancel"
              ? "cancel"
              : endReasonRef.current;
        cb.current.onSessionEnd?.(reason);
      }
    },
    [clearTimers, flushSpeechUsage, runEffects, stopEnergyLoop, teardownDeepgram, teardownRecognition],
  );
  // Layout, not passive: `audiostart` can land ~5ms after `start()`, and a passive effect
  // may not have run by then — leaving the engine talking to the no-op default.
  useLayoutEffect(() => {
    dispatchRef.current = dispatch;
  });

  const start = useCallback(() => dispatch({ t: "start", now: Date.now() }), [dispatch]);
  const stop = useCallback(() => {
    endReasonRef.current = "user";
    dispatch({ t: "stop" });
  }, [dispatch]);
  const cancel = useCallback(() => dispatch({ t: "cancel" }), [dispatch]);

  // `supported` is layered over the machine here rather than baked into it, so the
  // reducer stays a pure function of events.
  const state: DictationState = supported ? machine.state : "unsupported";
  const listening = state === "listening" || state === "requesting";
  const toggle = useCallback(() => {
    if (machineRef.current.state === "listening" || machineRef.current.state === "requesting") {
      stop();
    } else {
      start();
    }
  }, [start, stop]);

  // A settled error should not stick to the button forever.
  useEffect(() => {
    if (machine.state !== "error") return;
    const t = setTimeout(() => dispatchRef.current({ t: "reset" }), 1200);
    return () => clearTimeout(t);
  }, [machine.state, machine.error]);

  // A lit mic indicator on a backgrounded tab is a privacy smell, and burns battery.
  useEffect(() => {
    if (!listening) return;
    const drop = () => dispatchRef.current({ t: "cancel" });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") drop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", drop);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", drop);
    };
  }, [listening]);

  // Unmount: null the handlers BEFORE abort(), which fires onend synchronously.
  useEffect(
    () => () => {
      sessionIdRef.current = -1;
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      const rec = recRef.current;
      if (rec) {
        rec.onaudiostart = null;
        rec.onspeechstart = null;
        rec.onspeechend = null;
        rec.onsoundstart = null;
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        try {
          rec.abort();
        } catch {
          /* already gone */
        }
        recRef.current = null;
      }
      // A route change with no pagehide/visibilitychange must still drop the socket and
      // release the mic — otherwise a live Deepgram session outlives the component that
      // opened it.
      if (dgHandleRef.current) dgSuppressCloseRef.current = true;
      flushSpeechUsage(dgHandleRef.current);
      teardownDeepgram();
    },
    [flushSpeechUsage, teardownDeepgram],
  );

  return useMemo(
    () => ({
      state,
      supported: state !== "unsupported",
      listening,
      error: machine.error,
      level,
      engine,
      start,
      stop,
      cancel,
      toggle,
    }),
    [cancel, engine, level, listening, machine.error, start, state, stop, toggle],
  );
}
