/**
 * The pure half of voice capture: resampling, WAV framing, level metering and the caps.
 *
 * Deliberately free of React, of DOM globals and of `AudioContext`, so that
 * `scripts/smoke-voice-recording.ts` can exercise every number under plain node. The live
 * microphone wiring lives in `use-voice-recorder.ts`; this file never touches a device.
 * Same split as `dictation.ts` / `use-dictation.ts`, for the same reason.
 *
 * WHY WAV AND NOT `MediaRecorder`. The obvious way to record in a browser is
 * `MediaRecorder`, which hands back webm/opus. Three things argue against it here:
 *
 *   1. Wispr's transcribe endpoint takes base64 16 kHz WAV and nothing else, so webm would
 *      need transcoding, and Vercel's serverless runtime has no ffmpeg to do it with.
 *   2. Whisper and Gemini both accept WAV too, so one recording format feeds all three
 *      engines and the fallback chain in `transcribeAudioWithAI` never has to re-encode.
 *   3. `MediaRecorder`'s mime support is genuinely inconsistent across Safari versions,
 *      whereas `AudioContext` + a worklet is uniform.
 *
 * The cost is size: 16 kHz mono int16 is 32 KB/s where opus is ~8 KB/s. At the six-minute
 * cap that is ~11.5 MB, which fits inside `CAPTURE_MAX_UPLOAD_BYTES` (22 MB) with room to
 * spare, so the trade is paid for.
 */

/** What every engine in the chain wants, and the only rate this module emits. */
export const TARGET_SAMPLE_RATE = 16_000;

/**
 * The hard ceiling on one recording.
 *
 * Six minutes is Wispr's documented per-request limit, and it is far longer than the
 * thirty-second note this feature exists for. Enforced client-side so a long recording is
 * stopped and kept, rather than uploaded and rejected — losing six minutes of someone's
 * speech to a 413 would be the worst failure this feature could have.
 */
export const MAX_RECORDING_MS = 6 * 60_000;

/** Wispr's per-request payload ceiling, checked before we bother encoding base64. */
export const WISPR_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Below this, treat a recording as a mis-tap and discard it rather than spending an AI
 * call on it. Deliberately short: "Met Sara, follow up Tuesday" is about two seconds, and
 * a threshold that ate real notes would be much worse than one that occasionally lets a
 * fumble through.
 */
export const MIN_RECORDING_MS = 700;

/** Bytes in the RIFF/WAVE header this module writes: 12 (RIFF) + 24 (fmt ) + 8 (data). */
export const WAV_HEADER_BYTES = 44;

// ── Resampling ────────────────────────────────────────────────────────────────────────

/**
 * Float32 mic samples at `inputRate` → int16 at `TARGET_SAMPLE_RATE`.
 *
 * `AudioContext` is *asked* for 16 kHz in the hook, but asking is not getting: Safari and
 * several Android builds ignore the hint and hand back the hardware rate (44100 or 48000).
 * So the real rate is read back off the context and passed in here, and this function has
 * to cope with whatever it is. Never assume the ratio is an integer — 44100/16000 is
 * 2.75625.
 *
 * Downsampling averages each output sample over its whole input window rather than picking
 * one sample from it. Picking is one line shorter and aliases audibly: a decimated 48 kHz
 * signal folds everything above 8 kHz back down into the speech band as a metallic buzz,
 * and transcription accuracy on it is visibly worse. The box filter is not a great
 * anti-alias filter, but it is a real one and it costs nothing.
 */
export function downsampleTo16k(
  input: Float32Array,
  inputRate: number,
): Int16Array {
  if (!Number.isFinite(inputRate) || inputRate <= 0) {
    throw new Error(`downsampleTo16k: bad input rate ${inputRate}`);
  }
  if (input.length === 0) return new Int16Array(0);

  const ratio = inputRate / TARGET_SAMPLE_RATE;

  // Already at target (or close enough that resampling would only add error).
  if (Math.abs(ratio - 1) < 1e-9) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = floatToInt16(input[i]);
    return out;
  }

  // Upsampling. Only reachable from hardware that captures below 16 kHz, which in practice
  // means a few Bluetooth headsets pinned to the 8 kHz call profile. Sample-and-hold, not
  // interpolation: the information is not there either way, and hold is honest about that.
  if (ratio < 1) {
    const outLength = Math.floor(input.length / ratio);
    const out = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
      out[i] = floatToInt16(input[Math.min(input.length - 1, Math.floor(i * ratio))]);
    }
    return out;
  }

  const outLength = Math.floor(input.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    // `Math.ceil` on the far edge, so windows tile the input with no dropped samples.
    const end = Math.min(input.length, Math.ceil((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = floatToInt16(sum / Math.max(1, end - start));
  }
  return out;
}

/**
 * `downsampleTo16k` for a stream of small frames, carrying the remainder between calls.
 *
 * The stateless version is exact for one buffer but lossy per worklet frame: 128 samples
 * at 48 kHz is 42.67 output samples, `Math.floor` keeps 42, and the last two input samples
 * of every frame are dropped. That is 1.6% of the audio gone, a tiny discontinuity every
 * 2.7 ms, and — over an hour-long meeting — a timeline almost a minute short. This keeps
 * the unconsumed tail and prepends it to the next frame, so every input sample lands in
 * exactly one output window.
 */
export function createDownsampler(inputRate: number): (frame: Float32Array) => Int16Array {
  if (!Number.isFinite(inputRate) || inputRate <= 0) {
    throw new Error(`createDownsampler: bad input rate ${inputRate}`);
  }
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  // At or below the target rate there is no window to straddle a frame boundary.
  if (ratio <= 1 + 1e-9) return (frame) => downsampleTo16k(frame, inputRate);

  let carry = new Float32Array(0);
  // Where the next output window starts, as a fraction into `carry`. Kept because the
  // ratio is rarely whole (44100/16000 is 2.75625): rounding the window start at each
  // frame boundary instead would gain or lose a sample per frame — the bug this replaces,
  // just smaller.
  let phase = 0;
  return (frame) => {
    let input = frame;
    if (carry.length) {
      input = new Float32Array(carry.length + frame.length);
      input.set(carry);
      input.set(frame, carry.length);
    }
    const count = Math.max(0, Math.floor((input.length - phase) / ratio));
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      // The same box filter as `downsampleTo16k`, on a window that may start mid-sample.
      const start = Math.floor(phase + i * ratio);
      const end = Math.min(input.length, Math.ceil(phase + (i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out[i] = floatToInt16(sum / Math.max(1, end - start));
    }
    const next = phase + count * ratio;
    const consumed = Math.floor(next);
    carry = input.slice(consumed);
    phase = next - consumed;
    return out;
  };
}

/**
 * One float sample → one int16.
 *
 * The asymmetric scale is not a typo. Int16 runs -32768..32767, so the positive half has
 * one fewer step than the negative one. Scaling both by 32768 lets a sample of exactly 1.0
 * wrap to -32768 — a full-scale click on every clipped peak, which is precisely where loud
 * speech lives. Clamp first, then scale each side by its own limit.
 */
function floatToInt16(sample: number): number {
  if (!Number.isFinite(sample)) return 0;
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
}

/** Join the worklet's per-frame chunks into the single buffer the encoder wants. */
export function concatInt16(chunks: readonly Int16Array[]): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// ── WAV framing ───────────────────────────────────────────────────────────────────────

/**
 * Wrap int16 PCM in a canonical 44-byte RIFF/WAVE header.
 *
 * Mono, 16-bit, little-endian throughout — the one shape every engine in the fallback
 * chain accepts without negotiation.
 */
export function encodeWav16(
  samples: Int16Array,
  sampleRate: number = TARGET_SAMPLE_RATE,
): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;

  writeAscii(view, 0, "RIFF");
  // Everything after this field, i.e. total length minus the 8 bytes of "RIFF" + size.
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk body length
  view.setUint16(20, 1, true); // format 1 = uncompressed PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  // `set` on an Int16Array view of the tail is ~10x faster than a setInt16 loop, and the
  // platforms this runs on are all little-endian, which is what WAV wants anyway.
  new Int16Array(buffer, WAV_HEADER_BYTES).set(samples);

  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Encoded size for a sample count, so the caller can check a cap before encoding. */
export function wavByteLength(sampleCount: number): number {
  return WAV_HEADER_BYTES + sampleCount * 2;
}

/** Base64 inflates by 4 bytes per 3, rounded up to the next quad. */
export function base64ByteLength(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Bytes → base64, which is the form `CaptureMediaFile.base64` wants.
 *
 * Hand-rolled rather than `btoa` or `Buffer` for two reasons. The small one is that this
 * module is shared by the browser and by `scripts/smoke-voice-recording.ts` under node, and
 * those two have different built-ins. The large one is that the obvious
 * `btoa(String.fromCharCode(...bytes))` throws `RangeError: Maximum call stack size
 * exceeded` on anything over a few hundred KB — the spread puts one argument on the stack
 * per byte — and a six-minute recording is 11 MB. Chunking is not optional here.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  // A multiple of 3, so every chunk but the last ends on a clean quad and needs no padding.
  const CHUNK = 3 * 1024;
  let chunk = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;

    chunk += B64_ALPHABET[b0 >> 2];
    chunk += B64_ALPHABET[((b0 & 0x03) << 4) | (has1 ? b1 >> 4 : 0)];
    chunk += has1 ? B64_ALPHABET[((b1 & 0x0f) << 2) | (has2 ? b2 >> 6 : 0)] : "=";
    chunk += has2 ? B64_ALPHABET[b2 & 0x3f] : "=";

    if (chunk.length >= CHUNK) {
      parts.push(chunk);
      chunk = "";
    }
  }
  if (chunk) parts.push(chunk);
  return parts.join("");
}

// ── Metering ──────────────────────────────────────────────────────────────────────────

/**
 * A 0..1 needle for the recording UI.
 *
 * Unlike `use-dictation.ts`, which has to *infer* energy from the cadence of recogniser
 * events because the Web Speech API never hands over audio, we are holding the samples.
 * So this is the real thing.
 *
 * RMS is mapped through a log curve because loudness is perceptual: linear RMS spends
 * nine-tenths of the bar's travel on the top 20 dB and leaves normal speech pinned near
 * zero. `FLOOR_DB` is roughly the noise floor of a laptop mic in a quiet room.
 */
export const FLOOR_DB = -60;

export function rmsLevel(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  if (db <= FLOOR_DB) return 0;
  return Math.min(1, db / -FLOOR_DB + 1);
}

// ── Formatting ────────────────────────────────────────────────────────────────────────

/** Elapsed time as `m:ss`, for the recorder's running clock. */
export function formatElapsed(ms: number): string {
  const safe = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Sample count → milliseconds at the target rate. */
export function samplesToMs(sampleCount: number): number {
  return (sampleCount / TARGET_SAMPLE_RATE) * 1000;
}

/** Milliseconds → sample count at the target rate, used to trim at the cap. */
export function msToSamples(ms: number): number {
  return Math.floor((ms / 1000) * TARGET_SAMPLE_RATE);
}
