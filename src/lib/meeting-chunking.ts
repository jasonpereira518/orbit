/**
 * Where a meeting recording is cut into chunks. Pure: fed 16 kHz int16 samples, hands back
 * finished chunks. No DOM, no `AudioContext`, so `scripts/smoke-meeting-chunking.ts` can
 * drive every boundary under plain node — the same split as `voice-recording.ts`.
 *
 * WHY CHUNK AT ALL. Every engine in the transcription chain has a per-request ceiling
 * (Wispr's is six minutes), Vercel refuses bodies over 4.5MB, and an hour of meeting held
 * in memory until Stop is an hour lost to one crashed tab. So the recorder sends about a
 * minute at a time and the transcript grows while the call is still going.
 *
 * WHY CUT ON SILENCE. A cut in the middle of a word is a word neither chunk transcribes
 * correctly. After the target length, the chunker waits for a short quiet stretch — the
 * gap between two sentences — and cuts there. A call with no pauses at all (music, one
 * person monologuing) still gets cut at the hard limit, and the previous chunk's tail is
 * sent as transcription context so even that cut usually heals.
 *
 * WHY THE SAMPLE COUNT IS THE CLOCK. During a meeting the Orbit tab is in the background,
 * and background tabs have their timers throttled — to once a minute after five minutes
 * in Chrome. The audio worklet is not throttled, so every decision here is made from the
 * number of samples that have arrived, never from `setTimeout`.
 */
import { TARGET_SAMPLE_RATE, concatInt16, msToSamples, wavByteLength } from "@/lib/voice-recording";

/** Cut after this much audio, at the next quiet stretch. */
export const MEETING_TARGET_CHUNK_MS = 60_000;
/** Cut here no matter what. ~2.9MB of WAV — under `MEETING_CHUNK_MAX_BYTES`. */
export const MEETING_MAX_CHUNK_MS = 90_000;
/** How long a pause has to be to cut in. About the gap between two sentences. */
export const QUIET_WINDOW_MS = 400;
/** The longest meeting one recording will hold. Stopped and kept, like voice notes. */
export const MAX_MEETING_MS = 3 * 60 * 60_000;

/** Analysis frame: 20 ms. Fine enough to find a pause, coarse enough to be free. */
export const FRAME_SAMPLES = TARGET_SAMPLE_RATE / 50;
const FRAME_MS = 20;
const QUIET_FRAMES = Math.ceil(QUIET_WINDOW_MS / FRAME_MS);

/**
 * A frame this loud is sound, whatever the room. -50 dBFS: well under speech (typically
 * -35 to -15) and over the floor of a muted tab, which is exact digital zero.
 */
const ABSOLUTE_VOICE_RMS = 0.003;
/** Less than this much sound in a whole chunk and it is silence — no transcription call. */
const MIN_VOICED_MS = 300;
const MIN_VOICED_FRAMES = Math.ceil(MIN_VOICED_MS / FRAME_MS);
/** The noise floor is the quietest frame in this window. Longer than any breath-free sentence. */
const FLOOR_WINDOW_FRAMES = 3000 / FRAME_MS;
/** A frame within ~8 dB of the floor is a pause… */
const QUIET_OVER_FLOOR = 2.5;
/** …provided it is also at least ~12 dB under the loudest recent frame. */
const QUIET_UNDER_PEAK = 0.25;

export type MeetingChunk = {
  seq: number;
  /** Offset from the start of the meeting (including any resumed part), in ms. */
  startMs: number;
  endMs: number;
  samples: Int16Array;
  /** Nothing above the noise floor for the whole chunk. Upload as a marker, not audio. */
  silent: boolean;
};

export type MeetingChunkerOptions = {
  /** First seq to emit. A resumed recording continues after the last stored one. */
  startSeq?: number;
  /** Where on the meeting's timeline this recorder begins, in ms. */
  startOffsetMs?: number;
  targetMs?: number;
  maxMs?: number;
};

/**
 * Stateful: `push` samples as they arrive, collect the chunks it returns, `flush` on stop.
 *
 * The noise floor is adaptive — it tracks the quietest recent frames — because a laptop in
 * a café and a headset in a quiet room differ by 30 dB, and a fixed "quiet" threshold that
 * works for one never finds a pause in the other.
 */
export class MeetingChunker {
  private seq: number;
  private readonly offsetMs: number;
  private readonly targetSamples: number;
  private readonly maxSamples: number;

  private frame = new Int16Array(FRAME_SAMPLES);
  private frameFill = 0;
  private parts: Int16Array[] = [];
  private chunkSamples = 0;
  private chunkStartSample = 0;
  private totalSamples = 0;

  private quietRun = 0;
  private voicedFrames = 0;
  /** Recent frame loudness, for the noise floor: the quietest frame of the last few seconds. */
  private recent = new Float32Array(FLOOR_WINDOW_FRAMES).fill(1);
  private recentAt = 0;

  constructor(opts: MeetingChunkerOptions = {}) {
    this.seq = opts.startSeq ?? 0;
    this.offsetMs = opts.startOffsetMs ?? 0;
    this.targetSamples = msToSamples(opts.targetMs ?? MEETING_TARGET_CHUNK_MS);
    this.maxSamples = msToSamples(opts.maxMs ?? MEETING_MAX_CHUNK_MS);
  }

  /** Audio received by this recorder so far, in ms. The recording clock. */
  get elapsedMs(): number {
    return (this.totalSamples / TARGET_SAMPLE_RATE) * 1000;
  }

  /** The seq the next chunk will carry. */
  get nextSeq(): number {
    return this.seq;
  }

  push(samples: Int16Array): MeetingChunk[] {
    const out: MeetingChunk[] = [];
    let i = 0;
    while (i < samples.length) {
      const take = Math.min(FRAME_SAMPLES - this.frameFill, samples.length - i);
      this.frame.set(samples.subarray(i, i + take), this.frameFill);
      this.frameFill += take;
      i += take;
      if (this.frameFill === FRAME_SAMPLES) {
        const chunk = this.endFrame();
        if (chunk) out.push(chunk);
      }
    }
    return out;
  }

  /** Emit whatever is left — the end of the meeting. Null when there is nothing. */
  flush(): MeetingChunk | null {
    if (this.frameFill > 0) {
      const partial = this.frame.slice(0, this.frameFill);
      this.analyze(partial);
      this.parts.push(partial);
      this.chunkSamples += partial.length;
      this.totalSamples += partial.length;
      this.frameFill = 0;
    }
    if (this.chunkSamples === 0) return null;
    return this.cut();
  }

  private endFrame(): MeetingChunk | null {
    const frame = this.frame;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.frameFill = 0;

    const quiet = this.analyze(frame);
    this.parts.push(frame);
    this.chunkSamples += frame.length;
    this.totalSamples += frame.length;
    this.quietRun = quiet ? this.quietRun + 1 : 0;

    if (this.chunkSamples >= this.maxSamples) return this.cut();
    if (this.chunkSamples >= this.targetSamples && this.quietRun >= QUIET_FRAMES) return this.cut();
    return null;
  }

  /**
   * Count sound and track the floor; returns whether this frame is quiet enough to cut in.
   *
   * The two thresholds are deliberately different. "Silent chunk" decides whether audio is
   * sent at all, so it is absolute and conservative: a chunk is skipped only when almost
   * nothing in it clears -50 dBFS, because a false "silent" loses someone's words and a
   * false "sound" only costs one transcription call. "Quiet enough to cut" is relative to
   * the room — the quietest frame of the last few seconds, which in speech is the gap
   * between words — so it finds pauses over café noise as well as in a silent office.
   */
  private analyze(frame: Int16Array): boolean {
    const rms = frameRms(frame);
    if (rms >= ABSOLUTE_VOICE_RMS) this.voicedFrames += 1;

    this.recent[this.recentAt] = rms;
    this.recentAt = (this.recentAt + 1) % this.recent.length;
    let floor = 1;
    let peak = 0;
    for (let i = 0; i < this.recent.length; i++) {
      const r = this.recent[i]!;
      if (r < floor) floor = r;
      if (r > peak && r < 1) peak = r;
    }

    // Near the floor AND well under what was loud a moment ago. The second half is what
    // stops a steady sound (music, a hum, a monologue with no breaths) from reading as one
    // endless pause: with nothing quieter in the window, the floor IS the sound, and only
    // the peak check says "this is not a gap".
    return (
      rms < Math.max(ABSOLUTE_VOICE_RMS, floor * QUIET_OVER_FLOOR) &&
      (rms < ABSOLUTE_VOICE_RMS || rms < peak * QUIET_UNDER_PEAK)
    );
  }

  private cut(): MeetingChunk {
    const samples = concatInt16(this.parts);
    const startMs = this.offsetMs + (this.chunkStartSample / TARGET_SAMPLE_RATE) * 1000;
    const endMs = startMs + (samples.length / TARGET_SAMPLE_RATE) * 1000;
    const chunk: MeetingChunk = {
      seq: this.seq,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      samples,
      silent: this.voicedFrames < MIN_VOICED_FRAMES,
    };
    this.seq += 1;
    this.chunkStartSample += samples.length;
    this.parts = [];
    this.chunkSamples = 0;
    this.quietRun = 0;
    this.voicedFrames = 0;
    return chunk;
  }
}

/** RMS of an int16 frame, 0..1. */
export function frameRms(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / frame.length);
}

/** Encoded size of the longest chunk the chunker can emit. Pinned by the smoke test. */
export function maxChunkWavBytes(maxMs: number = MEETING_MAX_CHUNK_MS): number {
  return wavByteLength(msToSamples(maxMs));
}
