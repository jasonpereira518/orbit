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
  FIRST_SPEECH_GRACE_MS,
  MAX_SESSION_MS,
  SILENCE_MS,
  dictationReducer,
  initialMachine,
  tidyTranscript,
  type DictationEffect,
  type DictationEndReason,
  type DictationErrorCode,
  type DictationEvent,
  type DictationState,
  type Machine,
} from "@/lib/dictation";

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

  // Whether the browser has an engine at all never changes after load, and must read
  // false on the server so hydration matches. The button appears a frame later; reserving
  // space for it instead would leave a permanent hole in Firefox.
  const supported = useSyncExternalStore(
    NO_SUPPORT_CHANGES,
    isDictationSupported,
    () => false,
  );

  // The machine always starts idle; `supported` is layered on at the bottom. That keeps
  // feature detection out of the reducer, which still owns the `unsupported` latch for a
  // browser whose constructor exists but whose engine does not.
  const [machine, setMachine] = useState<Machine>(() => initialMachine(true));
  // Kept current by `dispatch` itself, so two dispatches in one tick still compose.
  const machineRef = useRef(machine);

  const level = useMotionValue(0);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const sessionIdRef = useRef(0);
  /** Finals from PREVIOUS recognition instances, i.e. across internal restarts. */
  const baseCommittedRef = useRef("");
  const lastFinalsRef = useRef("");
  const spanLengthRef = useRef(0);
  const speakingRef = useRef(false);
  const energyRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heardSpeechRef = useRef(false);
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

  /** Restart the silence countdown. Longer before the first word than between words. */
  const armSilence = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    const wait = heardSpeechRef.current ? SILENCE_MS : FIRST_SPEECH_GRACE_MS;
    silenceTimerRef.current = setTimeout(() => {
      endReasonRef.current = "silence";
      dispatchRef.current({ t: "stop" });
    }, wait);
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
        armSilence();
      };
      rec.onspeechstart = () => {
        if (stale()) return;
        speakingRef.current = true;
        heardSpeechRef.current = true;
        armSilence();
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
        const grew = span.length - spanLengthRef.current;
        spanLengthRef.current = span.length;

        energyRef.current = Math.min(
          1,
          energyRef.current +
            ENERGY_PER_EVENT +
            Math.min(ENERGY_CHAR_CAP, Math.max(0, grew) * ENERGY_PER_CHAR),
        );

        heardSpeechRef.current = true;
        armSilence();
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
    [armSilence, lang],
  );

  const runEffects = useCallback(
    (effects: DictationEffect[], sessionId: number) => {
      for (const effect of effects) {
        cb.current.onEffect?.(effect);
        switch (effect) {
          case "start-recognition": {
            baseCommittedRef.current = "";
            lastFinalsRef.current = "";
            spanLengthRef.current = 0;
            heardSpeechRef.current = false;
            endReasonRef.current = "user";
            cb.current.onSessionStart?.();
            const rec = buildRecognition(sessionId);
            if (!rec) break;
            recRef.current = rec;
            try {
              rec.start();
            } catch {
              // Chrome throws InvalidStateError if start() races a live instance.
              break;
            }
            startEnergyLoop();
            armSilence();
            if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
            maxTimerRef.current = setTimeout(() => {
              endReasonRef.current = "silence";
              dispatchRef.current({ t: "stop" });
            }, MAX_SESSION_MS);
            break;
          }

          case "restart-recognition": {
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
            armSilence();
            break;
          }

          case "stop-recognition":
            // stop(), not abort(): the engine flushes its trailing words on the way out.
            try {
              recRef.current?.stop();
            } catch {
              /* already stopped */
            }
            break;

          case "abort-recognition": {
            clearTimers();
            stopEnergyLoop();
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
    [armSilence, buildRecognition, clearTimers, startEnergyLoop, stopEnergyLoop, teardownRecognition],
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
        const reason: DictationEndReason =
          next.state === "error"
            ? "error"
            : event.t === "cancel"
              ? "cancel"
              : endReasonRef.current;
        cb.current.onSessionEnd?.(reason);
      }
    },
    [clearTimers, runEffects, stopEnergyLoop, teardownRecognition],
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
    },
    [],
  );

  return useMemo(
    () => ({
      state,
      supported: state !== "unsupported",
      listening,
      error: machine.error,
      level,
      start,
      stop,
      cancel,
      toggle,
    }),
    [cancel, level, listening, machine.error, start, state, stop, toggle],
  );
}
