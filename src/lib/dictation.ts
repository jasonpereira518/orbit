/**
 * The pure half of voice dictation: transcript tidying, the anchored-span splice that
 * keeps dictated words from clobbering text the user typed, and the recogniser state
 * machine.
 *
 * Everything here is deliberately free of React and of DOM globals so that
 * `scripts/smoke-dictation.ts` can exercise it under plain node. The live
 * `SpeechRecognition` wiring lives in `use-dictation.ts`; this file never touches an
 * element, which is also why the hook can later drive the ask bar's `<input>` unchanged.
 */

// ── Timing ────────────────────────────────────────────────────────────────────────────

/** Silence that ends a session, once speech has actually been heard. */
export const SILENCE_MS = 2200;
/**
 * Grace before the FIRST word. Without a separate, longer window, clicking the mic and
 * taking a moment to gather your thought cuts you off before you say anything.
 */
export const FIRST_SPEECH_GRACE_MS = 7000;
/** Hard cap, so a forgotten tab cannot hold the mic open indefinitely. */
export const MAX_SESSION_MS = 90_000;

/** Chrome spin-loops end→start→end when the mic device disappears mid-session. */
export const RESTART_STORM_WINDOW_MS = 1000;
export const RESTART_STORM_LIMIT = 3;

/**
 * Some Firefox builds expose the constructor while the pref is off: construction
 * succeeds and `start()` errors immediately, before any audio. An error this fast, with
 * no `audiostart`, means the engine was never really there.
 */
export const UNSUPPORTED_LATCH_MS = 300;

// ── Types ─────────────────────────────────────────────────────────────────────────────

export type DictationState =
  | "unsupported"
  | "idle"
  | "requesting"
  | "listening"
  | "error";

export type DictationErrorCode =
  | "not-allowed"
  | "audio-capture"
  | "network"
  | "unknown";

export type DictationEndReason = "user" | "silence" | "error" | "cancel";

// ── Transcript tidying ────────────────────────────────────────────────────────────────

/**
 * Light cosmetic cleanup, and nothing more.
 *
 * Deliberately does NOT translate spoken punctuation words: Chrome's en-US recogniser
 * already emits real "," and "." characters, so mapping the word "period" to "." would
 * only ever corrupt real speech ("period tracking", "the period costume").
 *
 * MUST be idempotent — it runs on every interim event over a steadily growing string,
 * so `tidy(tidy(x)) === tidy(x)` is load-bearing, not a nicety.
 */
export function tidyTranscript(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim()
    .replace(/^([a-z])/, (m) => m.toUpperCase())
    .replace(/([.!?]\s+)([a-z])/g, (_m, p, c: string) => p + c.toUpperCase());
}

// ── Anchored span splice ──────────────────────────────────────────────────────────────

export type SpliceResult = {
  /** The whole field value with the dictated span replaced. */
  value: string;
  /** Index just past the new span — where the caret rides if it was already at the tail. */
  spanEnd: number;
};

/**
 * Replace `[anchor, anchor + prevSpan.length)` with `nextSpan`.
 *
 * Returns null when the anchor no longer describes the span — the user edited through
 * it, and the caller must stop rather than corrupt their text.
 */
export function spliceSpan(
  value: string,
  anchor: number,
  prevSpan: string,
  nextSpan: string,
): SpliceResult | null {
  if (anchor < 0 || anchor > value.length) return null;
  const end = anchor + prevSpan.length;
  if (end > value.length) return null;
  if (value.slice(anchor, end) !== prevSpan) return null;
  return {
    value: value.slice(0, anchor) + nextSpan + value.slice(end),
    spanEnd: anchor + nextSpan.length,
  };
}

/** What a user edit did to the anchor, or that it landed inside the dictated span. */
export const ANCHOR_INTERFERENCE = "interference" as const;
export type AnchorShift = number | typeof ANCHOR_INTERFERENCE;

/**
 * Track the anchor across the user's own typing.
 *
 * An edit before the span slides the anchor; an edit after it changes nothing; an edit
 * that touches the span itself is interference and ends the session.
 */
export function shiftAnchor(
  prevValue: string,
  nextValue: string,
  anchor: number,
  spanLength: number,
): AnchorShift {
  if (prevValue === nextValue) return anchor;

  const maxPrefix = Math.min(prevValue.length, nextValue.length);
  let p = 0;
  while (p < maxPrefix && prevValue[p] === nextValue[p]) p++;

  let s = 0;
  while (
    s < maxPrefix - p &&
    prevValue[prevValue.length - 1 - s] === nextValue[nextValue.length - 1 - s]
  ) {
    s++;
  }

  // The edit occupies [p, prevValue.length - s) in the old value.
  const editStart = p;
  const editEnd = prevValue.length - s;
  const delta = nextValue.length - prevValue.length;
  const spanEnd = anchor + spanLength;

  if (editEnd <= anchor) return anchor + delta;
  if (editStart >= spanEnd) return anchor;
  return ANCHOR_INTERFERENCE;
}

// ── State machine ─────────────────────────────────────────────────────────────────────

export type Machine = {
  state: DictationState;
  error: DictationErrorCode | null;
  /**
   * Set before we ask the engine to stop. Without it `onend` restarts immediately and
   * the stop button appears to do nothing.
   */
  intentionalStop: boolean;
  /** Chrome will not re-prompt after a denial; calling start() just replays the error. */
  denied: boolean;
  /** Bumped on every start so results flushed by a previous session can be discarded. */
  sessionId: number;
  startedAt: number;
  sawAudioStart: boolean;
  networkRetried: boolean;
  restartsAt: number[];
};

export type DictationEvent =
  | { t: "start"; now: number }
  | { t: "audiostart" }
  | { t: "result" }
  | { t: "stop" }
  | { t: "cancel" }
  | { t: "end"; now: number }
  | { t: "error"; code: string; now: number }
  /** Clear a settled error back to idle, without touching the engine. */
  | { t: "reset" };

/** Side effects the adapter must perform. The reducer itself stays pure. */
export type DictationEffect =
  | "start-recognition"
  | "restart-recognition"
  | "stop-recognition"
  | "abort-recognition"
  | "toast-denied"
  | "toast-no-microphone"
  | "toast-network";

export type Reduced = { machine: Machine; effects: DictationEffect[] };

export function initialMachine(supported: boolean): Machine {
  return {
    state: supported ? "idle" : "unsupported",
    error: null,
    intentionalStop: false,
    denied: false,
    sessionId: 0,
    startedAt: 0,
    sawAudioStart: false,
    networkRetried: false,
    restartsAt: [],
  };
}

export function dictationReducer(m: Machine, e: DictationEvent): Reduced {
  const keep = (patch: Partial<Machine> = {}, effects: DictationEffect[] = []): Reduced => ({
    machine: { ...m, ...patch },
    effects,
  });

  if (m.state === "unsupported") return keep();

  switch (e.t) {
    case "start": {
      if (m.denied) {
        return keep({ state: "error", error: "not-allowed" }, ["toast-denied"]);
      }
      if (m.state === "requesting" || m.state === "listening") return keep();
      return keep(
        {
          state: "requesting",
          error: null,
          intentionalStop: false,
          sawAudioStart: false,
          networkRetried: false,
          restartsAt: [],
          sessionId: m.sessionId + 1,
          startedAt: e.now,
        },
        ["start-recognition"],
      );
    }

    case "reset":
      if (m.state !== "error") return keep();
      return keep({ state: "idle", error: null });

    case "audiostart":
      if (m.state !== "requesting" && m.state !== "listening") return keep();
      return keep({ state: "listening", sawAudioStart: true });

    case "result":
      // Safari is unreliable about `audiostart`; a result proves the mic is live.
      if (m.state !== "requesting" && m.state !== "listening") return keep();
      return keep({ state: "listening", sawAudioStart: true });

    case "stop":
      if (m.state !== "requesting" && m.state !== "listening") return keep();
      return keep({ intentionalStop: true }, ["stop-recognition"]);

    case "cancel":
      // Bumping the session invalidates any result the abort flushes on its way out.
      return keep(
        {
          state: "idle",
          error: null,
          intentionalStop: true,
          sessionId: m.sessionId + 1,
        },
        ["abort-recognition"],
      );

    case "end": {
      if (m.state === "error") return keep();
      if (m.intentionalStop) return keep({ state: "idle" });

      // Not our doing: the engine timed out server-side. Restart, unless it is storming.
      const restartsAt = [...m.restartsAt, e.now].filter(
        (t) => e.now - t < RESTART_STORM_WINDOW_MS,
      );
      if (restartsAt.length >= RESTART_STORM_LIMIT) {
        return keep(
          {
            state: "error",
            error: "audio-capture",
            intentionalStop: true,
            restartsAt: [],
          },
          ["toast-no-microphone"],
        );
      }
      return keep({ restartsAt }, ["restart-recognition"]);
    }

    case "error": {
      switch (e.code) {
        // Ours: what abort() produces, and what Chrome emits when the tab loses the mic.
        case "aborted":
          return keep();

        // The engine's own endpointer reaching the same conclusion as our silence timer.
        case "no-speech":
          return keep({ intentionalStop: true });

        case "not-allowed":
        case "service-not-allowed": {
          const neverStarted =
            !m.sawAudioStart && e.now - m.startedAt < UNSUPPORTED_LATCH_MS;
          if (neverStarted) {
            // The constructor existed but the engine does not. Withdraw the feature.
            return keep({ state: "unsupported", intentionalStop: true });
          }
          return keep(
            {
              state: "error",
              error: "not-allowed",
              denied: true,
              intentionalStop: true,
            },
            ["toast-denied"],
          );
        }

        case "audio-capture":
          return keep(
            { state: "error", error: "audio-capture", intentionalStop: true },
            ["toast-no-microphone"],
          );

        case "network":
          // Chrome's recogniser is cloud-backed; one blip is not worth a toast.
          if (!m.networkRetried) return keep({ networkRetried: true });
          return keep(
            { state: "error", error: "network", intentionalStop: true },
            ["toast-network"],
          );

        default:
          return keep({ state: "error", error: "unknown", intentionalStop: true });
      }
    }
  }
}
