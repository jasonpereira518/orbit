"use client";

/**
 * The live half of voice capture: binds a real microphone to the pure helpers in
 * `voice-recording.ts` and hands back one finished WAV.
 *
 * The hook emits bytes and nothing else — it never reads or writes an element and knows
 * nothing about capture, so the same recorder can later sit on a contact profile or in a
 * sheet without change. Shaped after `use-dictation.ts` on purpose, down to the
 * `MotionValue` meter, so the two read as siblings.
 *
 * The difference worth knowing: `use-dictation` has to *infer* speech energy from the
 * cadence of recogniser events, because the Web Speech API never hands over audio. Here we
 * own the samples, so `level` is a real measurement.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMotionValue, type MotionValue } from "motion/react";
import {
  MAX_RECORDING_MS,
  MIN_RECORDING_MS,
  TARGET_SAMPLE_RATE,
  bytesToBase64,
  concatInt16,
  downsampleTo16k,
  encodeWav16,
  msToSamples,
  rmsLevel,
  samplesToMs,
} from "@/lib/voice-recording";

const WORKLET_URL = "/orbit-pcm-worklet.js";
const WORKLET_NAME = "orbit-pcm-recorder";

/** How often the running clock re-renders. Fast enough to look live, slow enough to be free. */
const TICK_MS = 200;

/**
 * The meter decays toward each new reading rather than snapping to it. A raw per-quantum
 * RMS at 125 Hz reads as a flicker; this is the same smoothing `use-dictation` applies to
 * its inferred energy, for the same reason.
 */
const LEVEL_ATTACK = 0.5;
const LEVEL_RELEASE = 0.12;

export type VoiceRecorderState =
  | "unsupported"
  | "idle"
  | "requesting"
  | "recording"
  | "encoding"
  | "error";

export type VoiceRecorderErrorCode =
  | "not-allowed"
  | "no-microphone"
  | "insecure-context"
  | "too-short"
  | "unknown";

/** Why a session ended, so the caller can tell a finished note from an abandoned one. */
export type VoiceRecorderEndReason = "user" | "cap" | "cancel" | "error";

export type VoiceRecording = {
  /** Raw base64, no `data:` prefix — the shape `CaptureMediaFile` wants. */
  base64: string;
  mimeType: "audio/wav";
  filename: string;
  durationMs: number;
  /** Decoded byte length, for an upload-size check before the caller sends it. */
  byteLength: number;
};

export type UseVoiceRecorderOptions = {
  onRecording: (recording: VoiceRecording) => void;
  onError?: (code: VoiceRecorderErrorCode) => void;
  onSessionEnd?: (reason: VoiceRecorderEndReason) => void;
  /** Fired once when the session is stopped by the length cap rather than by the user. */
  onCapReached?: () => void;
};

export type VoiceRecorderHandle = {
  state: VoiceRecorderState;
  error: VoiceRecorderErrorCode | null;
  /** 0..1, measured. A MotionValue: 60fps React state would re-render the whole panel. */
  level: MotionValue<number>;
  /** Rounded to `TICK_MS`; drives the running clock only. */
  elapsedMs: number;
  recording: boolean;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  /** Clear a settled error back to idle, without touching the device. */
  reset: () => void;
};

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Whether this browser can record at all.
 *
 * `getUserMedia` is undefined rather than merely failing on an insecure origin, so this
 * also covers a page served over plain http — which is worth distinguishing in the UI,
 * because it is fixable by the developer and not by the user.
 */
export function isVoiceRecordingSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (!getAudioContextCtor()) return false;
  if (typeof AudioWorkletNode === "undefined") return false;
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

export function useVoiceRecorder(
  options: UseVoiceRecorderOptions,
): VoiceRecorderHandle {
  const { onRecording, onError, onSessionEnd, onCapReached } = options;

  // Read from a live ref so the worklet's message handler, bound once per session, never
  // captures a stale closure.
  const cb = useRef({ onRecording, onError, onSessionEnd, onCapReached });
  useLayoutEffect(() => {
    cb.current = { onRecording, onError, onSessionEnd, onCapReached };
  });

  const [state, setState] = useState<VoiceRecorderState>("idle");
  const [error, setError] = useState<VoiceRecorderErrorCode | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const level = useMotionValue(0);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const chunksRef = useRef<Int16Array[]>([]);
  const sampleCountRef = useRef(0);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const capRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped on every start, so a frame flushed by a previous session is discarded. */
  const sessionRef = useRef(0);
  /** Set before we tear down, so the teardown path knows what it is finishing. */
  const endReasonRef = useRef<VoiceRecorderEndReason>("user");

  /**
   * Release the device.
   *
   * Stopping the tracks is what actually turns off the browser's recording indicator, and
   * doing it promptly matters more than it looks: a tab that holds a live microphone after
   * the user thinks they stopped is a trust problem, not a resource one. Closing the
   * context is best-effort — Safari can reject `close()` on an already-interrupted context
   * and there is nothing useful to do about it.
   */
  const teardown = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (capRef.current) clearTimeout(capRef.current);
    tickRef.current = null;
    capRef.current = null;

    const node = nodeRef.current;
    if (node) {
      try {
        node.port.postMessage("stop");
      } catch {
        // The worklet is already gone; the disconnect below is what matters.
      }
      node.port.onmessage = null;
      node.disconnect();
    }
    nodeRef.current = null;

    sourceRef.current?.disconnect();
    sourceRef.current = null;

    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;

    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});

    level.set(0);
  }, [level]);

  /** Everything a finished session needs: encode, hand over, reset. */
  const finish = useCallback(
    (reason: VoiceRecorderEndReason) => {
      const chunks = chunksRef.current;
      chunksRef.current = [];
      sampleCountRef.current = 0;
      teardown();

      if (reason === "cancel") {
        setState("idle");
        setElapsedMs(0);
        cb.current.onSessionEnd?.("cancel");
        return;
      }

      setState("encoding");

      // Already at 16 kHz: the chunks were resampled as they arrived.
      const samples = concatInt16(chunks);
      const durationMs = samplesToMs(samples.length);

      if (durationMs < MIN_RECORDING_MS) {
        // A mis-tap. Refusing costs the user nothing and saves an AI call on a click.
        setState("error");
        setError("too-short");
        setElapsedMs(0);
        cb.current.onError?.("too-short");
        cb.current.onSessionEnd?.("error");
        return;
      }

      const wav = encodeWav16(samples, TARGET_SAMPLE_RATE);
      const recording: VoiceRecording = {
        base64: bytesToBase64(wav),
        mimeType: "audio/wav",
        filename: `voice-note-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.wav`,
        durationMs,
        byteLength: wav.byteLength,
      };

      setState("idle");
      setElapsedMs(0);
      cb.current.onRecording(recording);
      cb.current.onSessionEnd?.(reason);
    },
    [teardown],
  );

  const fail = useCallback(
    (code: VoiceRecorderErrorCode) => {
      chunksRef.current = [];
      sampleCountRef.current = 0;
      teardown();
      setState("error");
      setError(code);
      setElapsedMs(0);
      cb.current.onError?.(code);
      cb.current.onSessionEnd?.("error");
    },
    [teardown],
  );

  const stop = useCallback(() => {
    if (nodeRef.current === null) return;
    endReasonRef.current = "user";
    finish("user");
  }, [finish]);

  const cancel = useCallback(() => {
    if (nodeRef.current === null) return;
    endReasonRef.current = "cancel";
    finish("cancel");
  }, [finish]);

  const reset = useCallback(() => {
    setState((s) => (s === "error" ? "idle" : s));
    setError(null);
  }, []);

  const start = useCallback(() => {
    if (nodeRef.current !== null) return;
    if (!isVoiceRecordingSupported()) {
      // An insecure origin is the one unsupported case a developer can fix, so it is worth
      // naming separately from a browser that simply has no worklet.
      fail(
        typeof window !== "undefined" && !window.isSecureContext
          ? "insecure-context"
          : "unknown",
      );
      return;
    }

    const session = ++sessionRef.current;
    setError(null);
    setElapsedMs(0);
    setState("requesting");

    // CONSTRUCTED SYNCHRONOUSLY, INSIDE THE CLICK. This must not move below the
    // `getUserMedia` await. iOS Safari only lets an AudioContext start while the user
    // activation from the tap is still live, and that activation does not survive the
    // permission round-trip: a context built afterwards comes back `suspended` and
    // `resume()` is refused, so the meter sits at zero and the recording is silent — on
    // the exact device this feature exists for. `teardown` closes it on every failure
    // path, including a denied permission.
    const Ctor = getAudioContextCtor();
    if (!Ctor) {
      fail("unknown");
      return;
    }
    // Asking for 16 kHz saves the resample when it is honoured. Safari and several Android
    // builds ignore it and give the hardware rate, which is why every consumer reads
    // `ctx.sampleRate` back rather than assuming.
    const ctx = new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
    ctxRef.current = ctx;

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            // On by default in most browsers, but stated explicitly because a note dictated
            // on a street or in a lobby is the normal case for this feature, not the edge.
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (session !== sessionRef.current) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;

        // Autoplay policy can hand back a suspended context even inside a click handler.
        if (ctx.state === "suspended") await ctx.resume();

        await ctx.audioWorklet.addModule(WORKLET_URL);
        if (session !== sessionRef.current) return;

        const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
        });
        const source = ctx.createMediaStreamSource(stream);
        source.connect(node);
        // Deliberately NOT connected to `ctx.destination`: with zero outputs there is
        // nothing to route, and routing the mic to the speakers would be feedback.

        const inputRate = ctx.sampleRate;
        const capSamples = msToSamples(MAX_RECORDING_MS);

        node.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (session !== sessionRef.current) return;
          const frame = event.data;
          if (!frame || frame.length === 0) return;

          // Meter from the pre-resample frame: it is the signal the user is actually
          // making, and asymmetric attack/release keeps the needle readable.
          const measured = rmsLevel(frame);
          const current = level.get();
          const smoothing = measured > current ? LEVEL_ATTACK : LEVEL_RELEASE;
          level.set(current + (measured - current) * smoothing);

          // Resample on arrival rather than hoarding float frames and converting at the
          // end: it turns a 33 MB float buffer into an 11 MB int one at the six-minute cap,
          // and spreads the cost over the session instead of stalling the stop button.
          const resampled = downsampleTo16k(frame, inputRate);
          if (resampled.length === 0) return;

          const remaining = capSamples - sampleCountRef.current;
          if (remaining <= 0) return;
          const kept =
            resampled.length <= remaining ? resampled : resampled.subarray(0, remaining);
          chunksRef.current.push(kept);
          sampleCountRef.current += kept.length;
        };

        nodeRef.current = node;
        sourceRef.current = source;
        startedAtRef.current = Date.now();
        chunksRef.current = [];
        sampleCountRef.current = 0;
        setState("recording");

        tickRef.current = setInterval(() => {
          setElapsedMs(Date.now() - startedAtRef.current);
        }, TICK_MS);

        // The cap stops and KEEPS the recording. Discarding six minutes of someone's
        // speech because they ran long would be the worst thing this feature could do.
        capRef.current = setTimeout(() => {
          if (session !== sessionRef.current) return;
          cb.current.onCapReached?.();
          endReasonRef.current = "cap";
          finish("cap");
        }, MAX_RECORDING_MS);
      } catch (err) {
        if (session !== sessionRef.current) return;
        fail(classifyGetUserMediaError(err));
      }
    })();
  }, [fail, finish, level]);

  // Release the device if the panel unmounts mid-recording — a route change must not leave
  // the microphone light on.
  useEffect(() => teardown, [teardown]);

  return {
    state,
    error,
    level,
    elapsedMs,
    recording: state === "recording",
    start,
    stop,
    cancel,
    reset,
  };
}

/**
 * Map a `getUserMedia` rejection onto something we can write copy for.
 *
 * The names are the spec's, but browsers disagree about which one they throw: Chrome says
 * `NotAllowedError` for both a denial and a policy block, Firefox says `NotFoundError`
 * where Chrome says `NotReadableError`. Group by what the user can do about it, not by the
 * name.
 */
function classifyGetUserMediaError(err: unknown): VoiceRecorderErrorCode {
  const name = err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return "not-allowed";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "NotReadableError":
    case "TrackStartError":
    case "OverconstrainedError":
      return "no-microphone";
    default:
      return "unknown";
  }
}
