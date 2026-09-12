"use client";

/**
 * The live half of meeting capture: the audio a call plays through this computer, mixed
 * with the user's microphone, cut into ~minute-long WAV chunks.
 *
 * A sibling of `use-voice-recorder.ts` and built the same way — AudioContext made inside
 * the click, the same `/orbit-pcm-worklet.js` tap, the same resample-on-arrival — with two
 * differences that shape everything else:
 *
 * WHERE THE CALL'S AUDIO COMES FROM. A web page cannot read the speakers. It can ask to
 * share a screen, window or tab *with its audio*, which is what `getDisplayMedia` does:
 *   - Google Meet in a tab → share that tab, with "Also share tab audio" on.
 *   - The Zoom app → share the entire screen, with "Also share system audio" on. Windows
 *     and ChromeOS only, and macOS from Chrome 141 on macOS 14.2+.
 * Chromium on desktop only; Safari and Firefox return video without audio. Chrome insists
 * on a video track too, so one is requested at the lowest cost the browser allows and kept
 * — disabled, not stopped, because stopping it can end the capture on some builds.
 *
 * WHY THE MIC IS MIXED IN. What leaves the speakers is everyone *but* the user, so on its
 * own the transcript would have the other side of every exchange and none of the user's
 * own commitments. Both sources feed one worklet node, and the graph downmixes them to
 * mono before the worklet — which matters, because the worklet reads channel 0 only and
 * shared tab audio is stereo.
 *
 * The hook emits chunks and nothing else. Uploading, retrying and transcribing live in
 * `meeting-upload-queue.ts` and the panel.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMotionValue, type MotionValue } from "motion/react";
import { createDownsampler, encodeWav16, rmsLevel, TARGET_SAMPLE_RATE } from "@/lib/voice-recording";
import { MAX_MEETING_MS, MeetingChunker, type MeetingChunk } from "@/lib/meeting-chunking";

const WORKLET_URL = "/orbit-pcm-worklet.js";
const WORKLET_NAME = "orbit-pcm-recorder";
const TICK_MS = 500;
/** Poll the per-source meters every N worklet frames (~30 Hz at 48 kHz). */
const METER_EVERY_FRAMES = 12;
const LEVEL_ATTACK = 0.5;
const LEVEL_RELEASE = 0.12;

export type MeetingRecorderState = "idle" | "requesting" | "recording" | "error";

export type MeetingRecorderErrorCode =
  /** The share picker was closed, or permission was refused. */
  | "cancelled"
  /** Something was shared, but without its audio. The most common mistake by far. */
  | "no-audio"
  | "insecure-context"
  | "unsupported"
  | "unknown";

export type MeetingRecorderEndReason = "user" | "cap" | "share-ended" | "error";

export type RecordedMeetingChunk = MeetingChunk & {
  /** WAV bytes, or null for a silent chunk — the queue sends it as a marker. */
  wav: Uint8Array | null;
};

export type MeetingSurface = "browser" | "window" | "monitor" | null;

export type MeetingRecorderStart = {
  includeMic: boolean;
  /** Continue a resumed meeting's numbering and timeline. */
  startSeq?: number;
  startOffsetMs?: number;
};

export type UseMeetingRecorderOptions = {
  onChunk: (chunk: RecordedMeetingChunk) => void;
  onStarted?: (info: { surface: MeetingSurface; micActive: boolean }) => void;
  onEnd?: (reason: MeetingRecorderEndReason, elapsedMs: number) => void;
  onError?: (code: MeetingRecorderErrorCode) => void;
  /** The mic was asked for and refused, or dropped mid-call. Recording carries on without it. */
  onMicLost?: () => void;
};

export type MeetingRecorderHandle = {
  state: MeetingRecorderState;
  error: MeetingRecorderErrorCode | null;
  /** 0..1 — the call's audio, measured. */
  callLevel: MotionValue<number>;
  /** 0..1 — the user's microphone. Stays 0 when the mic is off. */
  micLevel: MotionValue<number>;
  /** This recorder's audio so far, from the sample count. */
  elapsedMs: number;
  surface: MeetingSurface;
  micActive: boolean;
  recording: boolean;
  start: (opts: MeetingRecorderStart) => void;
  stop: () => void;
  reset: () => void;
};

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Whether this browser can record a meeting at all. Desktop Chromium is the only engine
 * that returns audio from `getDisplayMedia`, but there is no way to ask without prompting —
 * so this checks for the API and a desktop-width, pointer-driven screen, and the recorder
 * reports `no-audio` if a browser hands back video only.
 */
export function isMeetingCaptureSupported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (!window.isSecureContext) return false;
  if (!getAudioContextCtor() || typeof AudioWorkletNode === "undefined") return false;
  if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") return false;
  return window.matchMedia("(min-width: 768px) and (pointer: fine)").matches;
}

export function useMeetingRecorder(options: UseMeetingRecorderOptions): MeetingRecorderHandle {
  const cb = useRef(options);
  useLayoutEffect(() => {
    cb.current = options;
  });

  const [state, setState] = useState<MeetingRecorderState>("idle");
  const [error, setError] = useState<MeetingRecorderErrorCode | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [surface, setSurface] = useState<MeetingSurface>(null);
  const [micActive, setMicActive] = useState(false);
  const callLevel = useMotionValue(0);
  const micLevel = useMotionValue(0);

  const ctxRef = useRef<AudioContext | null>(null);
  const displayRef = useRef<MediaStream | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const nodesRef = useRef<AudioNode[]>([]);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const chunkerRef = useRef<MeetingChunker | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef(0);
  const endedRef = useRef(true);

  const teardown = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;

    const worklet = workletRef.current;
    if (worklet) {
      try {
        worklet.port.postMessage("stop");
      } catch {
        // Already gone.
      }
      worklet.port.onmessage = null;
    }
    workletRef.current = null;
    for (const node of nodesRef.current) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    nodesRef.current = [];

    // Stopping every track is what takes down Chrome's "sharing" bar and the mic light.
    // A meeting recorder that keeps either up after Stop is a trust problem.
    for (const stream of [displayRef.current, micRef.current]) {
      for (const track of stream?.getTracks() ?? []) {
        track.onended = null;
        track.stop();
      }
    }
    displayRef.current = null;
    micRef.current = null;

    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});

    callLevel.set(0);
    micLevel.set(0);
    setMicActive(false);
  }, [callLevel, micLevel]);

  /** Stop, emit the final chunk, tear down. Safe to call twice. */
  const finish = useCallback(
    (reason: MeetingRecorderEndReason) => {
      if (endedRef.current) return;
      endedRef.current = true;
      const chunker = chunkerRef.current;
      chunkerRef.current = null;
      const elapsed = chunker?.elapsedMs ?? 0;
      const last = chunker?.flush();
      teardown();
      if (last) cb.current.onChunk(withWav(last));
      setState("idle");
      cb.current.onEnd?.(reason, elapsed);
    },
    [teardown]
  );

  const fail = useCallback(
    (code: MeetingRecorderErrorCode) => {
      endedRef.current = true;
      chunkerRef.current = null;
      teardown();
      setState("error");
      setError(code);
      cb.current.onError?.(code);
    },
    [teardown]
  );

  const stop = useCallback(() => finish("user"), [finish]);

  const reset = useCallback(() => {
    setState((s) => (s === "error" ? "idle" : s));
    setError(null);
  }, []);

  const start = useCallback(
    (opts: MeetingRecorderStart) => {
      if (!endedRef.current) return;
      if (!isMeetingCaptureSupported()) {
        fail(typeof window !== "undefined" && !window.isSecureContext ? "insecure-context" : "unsupported");
        return;
      }
      const session = ++sessionRef.current;
      setError(null);
      setElapsedMs(0);
      setSurface(null);
      setState("requesting");

      // INSIDE THE CLICK, before any await — see `use-voice-recorder.ts`. The share picker
      // can sit open for a while, and a context built after it is liable to come back
      // suspended by the autoplay policy. Default rate, not 16 kHz: the stream is resampled
      // on arrival anyway, and a context whose rate differs from a capture track's is the
      // one combination browsers have historically refused to connect.
      const Ctor = getAudioContextCtor()!;
      const ctx = new Ctor();
      ctxRef.current = ctx;

      // Also inside the click: `getDisplayMedia` requires transient activation.
      const displayRequest = requestDisplayAudio();

      void (async () => {
        let display: MediaStream;
        try {
          display = await displayRequest;
        } catch (err) {
          if (session !== sessionRef.current) return;
          const name = err instanceof Error ? err.name : "";
          fail(name === "NotAllowedError" || name === "AbortError" ? "cancelled" : "unknown");
          return;
        }
        if (session !== sessionRef.current) {
          for (const t of display.getTracks()) t.stop();
          return;
        }
        displayRef.current = display;

        const audioTrack = display.getAudioTracks()[0];
        if (!audioTrack) {
          fail("no-audio");
          return;
        }
        const videoTrack = display.getVideoTracks()[0];
        const shared = (videoTrack?.getSettings() as MediaTrackSettings & { displaySurface?: string })
          ?.displaySurface;
        const sharedSurface: MeetingSurface =
          shared === "browser" || shared === "window" || shared === "monitor" ? shared : null;
        // Kept, not stopped — see the header. Disabled so nothing renders it.
        if (videoTrack) videoTrack.enabled = false;

        // The mic is best-effort. A meeting with only the call's audio is still worth
        // recording, so a refusal carries on without it and says so.
        let mic: MediaStream | null = null;
        if (opts.includeMic) {
          try {
            mic = await navigator.mediaDevices.getUserMedia({
              audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
          } catch {
            cb.current.onMicLost?.();
          }
          if (session !== sessionRef.current) {
            for (const t of mic?.getTracks() ?? []) t.stop();
            return;
          }
        }
        micRef.current = mic;

        try {
          if (ctx.state === "suspended") await ctx.resume();
          await ctx.audioWorklet.addModule(WORKLET_URL);
        } catch {
          if (session === sessionRef.current) fail("unknown");
          return;
        }
        if (session !== sessionRef.current) return;

        const worklet = new AudioWorkletNode(ctx, WORKLET_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          // THE DOWNMIX. Shared tab audio is stereo and the worklet reads channel 0 only;
          // channelCount 1 + "explicit" + "speakers" makes the graph fold L+R (and the mic)
          // into mono before it arrives, instead of silently dropping the right channel.
          channelCount: 1,
          channelCountMode: "explicit",
          channelInterpretation: "speakers",
        });
        const nodes: AudioNode[] = [worklet];

        const callSource = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
        const callAnalyser = ctx.createAnalyser();
        callAnalyser.fftSize = 1024;
        callSource.connect(worklet);
        callSource.connect(callAnalyser);
        nodes.push(callSource, callAnalyser);

        let micAnalyser: AnalyserNode | null = null;
        if (mic) {
          const micSource = ctx.createMediaStreamSource(mic);
          micAnalyser = ctx.createAnalyser();
          micAnalyser.fftSize = 1024;
          micSource.connect(worklet);
          micSource.connect(micAnalyser);
          nodes.push(micSource, micAnalyser);
        }
        // Never connected to the speakers: the call is already playing, and routing the mic
        // out would be feedback.

        const chunker = new MeetingChunker({
          startSeq: opts.startSeq ?? 0,
          startOffsetMs: opts.startOffsetMs ?? 0,
        });
        chunkerRef.current = chunker;
        // Stateful: per-frame `downsampleTo16k` drops the fractional tail of every 128-sample
        // frame, which over an hour is most of a minute — see `createDownsampler`.
        const downsample = createDownsampler(ctx.sampleRate);
        const capMs = MAX_MEETING_MS - (opts.startOffsetMs ?? 0);
        const meterBuf = new Float32Array(callAnalyser.fftSize);
        let frames = 0;

        worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (session !== sessionRef.current || chunkerRef.current !== chunker) return;
          const frame = event.data;
          if (!frame || frame.length === 0) return;

          if (++frames % METER_EVERY_FRAMES === 0) {
            callAnalyser.getFloatTimeDomainData(meterBuf);
            smooth(callLevel, rmsLevel(meterBuf));
            if (micAnalyser) {
              micAnalyser.getFloatTimeDomainData(meterBuf);
              smooth(micLevel, rmsLevel(meterBuf));
            }
          }

          const resampled = downsample(frame);
          if (resampled.length === 0) return;
          // Chunk boundaries come from here — the audio clock — never from a timer. This
          // tab spends the meeting in the background, where timers are throttled.
          for (const chunk of chunker.push(resampled)) cb.current.onChunk(withWav(chunk));

          // The cap stops and KEEPS the recording, like voice notes.
          if (chunker.elapsedMs >= capMs) finish("cap");
        };

        nodesRef.current = nodes;
        workletRef.current = worklet;
        endedRef.current = false;

        // "Stop sharing" in Chrome's own bar ends the track, not our session. Treat it as
        // Stop: the recording so far is kept and analyzed, never thrown away.
        audioTrack.onended = () => finish("share-ended");
        if (mic) {
          const micTrack = mic.getAudioTracks()[0];
          if (micTrack) {
            micTrack.onended = () => {
              setMicActive(false);
              micLevel.set(0);
              cb.current.onMicLost?.();
            };
          }
        }

        setSurface(sharedSurface);
        setMicActive(Boolean(mic));
        setState("recording");
        cb.current.onStarted?.({ surface: sharedSurface, micActive: Boolean(mic) });

        // Display only. The clock the recording actually runs on is the sample count; a
        // throttled interval just makes the number on screen update less often.
        tickRef.current = setInterval(() => {
          setElapsedMs(chunker.elapsedMs);
        }, TICK_MS);
      })();
    },
    [callLevel, micLevel, fail, finish]
  );

  // Leaving the page mid-meeting would lose the chunk in progress (everything before it is
  // already in the outbox). The browser's own prompt is the only warning that can fire here.
  useEffect(() => {
    if (state !== "recording") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [state]);

  // Unmounting mid-recording (an in-app navigation) must not leave the share or the mic
  // live. The partial chunk is flushed through `finish` so what was heard is still sent.
  useEffect(
    () => () => {
      finish("user");
      teardown();
    },
    [finish, teardown]
  );

  return {
    state,
    error,
    callLevel,
    micLevel,
    elapsedMs,
    surface,
    micActive,
    recording: state === "recording",
    start,
    stop,
    reset,
  };
}

function smooth(level: MotionValue<number>, measured: number) {
  const current = level.get();
  level.set(current + (measured - current) * (measured > current ? LEVEL_ATTACK : LEVEL_RELEASE));
}

function withWav(chunk: MeetingChunk): RecordedMeetingChunk {
  return { ...chunk, wav: chunk.silent ? null : encodeWav16(chunk.samples, TARGET_SAMPLE_RATE) };
}

/**
 * Ask for something to share, with its audio.
 *
 * `systemAudio: "include"` puts the "share system audio" option in the picker for a whole
 * screen; `selfBrowserSurface: "exclude"` keeps Orbit's own tab out of it, since sharing
 * the recorder with itself captures nothing. The video constraints ask for the cheapest
 * track the browser will give. Unknown dictionary members are ignored by WebIDL, so
 * browsers that do not know an option simply show their default picker.
 */
async function requestDisplayAudio(): Promise<MediaStream> {
  const options = {
    video: { frameRate: { ideal: 1, max: 5 }, width: { max: 640 }, height: { max: 480 } },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      // Keep the call audible to the user while it is being captured.
      suppressLocalAudioPlayback: false,
    },
    systemAudio: "include",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    preferCurrentTab: false,
    monitorTypeSurfaces: "include",
  } as DisplayMediaStreamOptions;
  try {
    return await navigator.mediaDevices.getDisplayMedia(options);
  } catch (err) {
    // Chromium throws TypeError for a constraint combination it dislikes BEFORE showing a
    // prompt, so activation is still live and the plain form works — see screenshot-capture.
    if (err instanceof TypeError) {
      return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    }
    throw err;
  }
}
