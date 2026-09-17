/**
 * The pure half of voice capture: resampling, WAV framing, metering and the caps. No DOM,
 * no AudioContext, no network — which is the whole reason the logic was split out of the
 * hook.
 * Run: npx tsx scripts/smoke-voice-recording.ts
 */
import {
  FLOOR_DB,
  MAX_RECORDING_MS,
  MIN_RECORDING_MS,
  TARGET_SAMPLE_RATE,
  WAV_HEADER_BYTES,
  WISPR_MAX_BYTES,
  base64ByteLength,
  bytesToBase64,
  concatInt16,
  downsampleTo16k,
  encodeWav16,
  formatElapsed,
  msToSamples,
  rmsLevel,
  samplesToMs,
  wavByteLength,
} from "../src/lib/voice-recording";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** A sine at `freq` Hz, `seconds` long, sampled at `rate`. */
function sine(freq: number, rate: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.floor(rate * seconds));
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
  }
  return out;
}

// ── downsampleTo16k ───────────────────────────────────────────────────────────────────
console.log("\ndownsampleTo16k");

check("empty input stays empty", downsampleTo16k(new Float32Array(0), 48_000).length === 0);

{
  // The three rates real hardware actually reports.
  for (const rate of [16_000, 44_100, 48_000]) {
    const input = sine(440, rate, 1);
    const out = downsampleTo16k(input, rate);
    const expected = Math.floor(input.length / (rate / TARGET_SAMPLE_RATE));
    check(
      `${rate} Hz → ${out.length} samples for 1s`,
      out.length === expected,
      `expected ${expected}`,
    );
    // One second in, one second out, whatever the input rate.
    check(
      `${rate} Hz preserves duration within 1ms`,
      Math.abs(samplesToMs(out.length) - 1000) < 1,
      `${samplesToMs(out.length)}ms`,
    );
  }
}

{
  // 44100/16000 = 2.75625. A loop that assumed an integer ratio would drift ~4% long here,
  // which over a six-minute note is 15 seconds of wrong timestamp.
  const out = downsampleTo16k(sine(200, 44_100, 10), 44_100);
  check(
    "non-integer ratio does not drift over 10s",
    Math.abs(samplesToMs(out.length) - 10_000) < 1,
    `${samplesToMs(out.length)}ms`,
  );
}

check(
  "passes 16 kHz through at the same length",
  downsampleTo16k(sine(300, 16_000, 0.5), 16_000).length === 8_000,
);

{
  // Bluetooth headsets pinned to the 8 kHz call profile.
  const out = downsampleTo16k(sine(300, 8_000, 1), 8_000);
  check("upsamples 8 kHz to the target rate", out.length === 16_000, `${out.length}`);
}

{
  const out = downsampleTo16k(sine(440, 48_000, 0.1), 48_000);
  let silent = true;
  for (let i = 0; i < out.length; i++) if (out[i] !== 0) silent = false;
  check("a real signal does not resample to silence", !silent);
}

for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  let threw = false;
  try {
    downsampleTo16k(sine(440, 16_000, 0.01), bad);
  } catch {
    threw = true;
  }
  check(`rejects an input rate of ${bad}`, threw);
}

// ── Clipping ──────────────────────────────────────────────────────────────────────────
console.log("\nclipping");

{
  // The asymmetry guard. Scaling both halves by 32768 wraps +1.0 to -32768, which is a
  // full-scale click on every clipped peak — exactly where loud speech lives. Do not
  // "simplify" this back to a single multiplier.
  const out = downsampleTo16k(Float32Array.from([1, -1, 0, 2, -2]), TARGET_SAMPLE_RATE);
  check("+1.0 maps to 32767, not -32768", out[0] === 32767, `${out[0]}`);
  check("-1.0 maps to -32768", out[1] === -32768, `${out[1]}`);
  check("0 maps to 0", out[2] === 0);
  check("over-range positive clamps, does not wrap", out[3] === 32767, `${out[3]}`);
  check("over-range negative clamps, does not wrap", out[4] === -32768, `${out[4]}`);
}

check(
  "NaN samples become silence, not garbage",
  downsampleTo16k(Float32Array.from([Number.NaN]), TARGET_SAMPLE_RATE)[0] === 0,
);

// ── concatInt16 ───────────────────────────────────────────────────────────────────────
console.log("\nconcatInt16");

{
  const joined = concatInt16([
    Int16Array.from([1, 2]),
    Int16Array.from([]),
    Int16Array.from([3, 4, 5]),
  ]);
  check("joins in order", Array.from(joined).join(",") === "1,2,3,4,5");
  check("no chunks is an empty buffer", concatInt16([]).length === 0);
}

// ── encodeWav16 ───────────────────────────────────────────────────────────────────────
console.log("\nencodeWav16");

{
  const samples = downsampleTo16k(sine(440, 48_000, 2), 48_000);
  const wav = encodeWav16(samples);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (at: number, len: number) =>
    String.fromCharCode(...Array.from(wav.slice(at, at + len)));

  check("starts with RIFF", ascii(0, 4) === "RIFF");
  check("declares WAVE", ascii(8, 4) === "WAVE");
  check("has an fmt chunk", ascii(12, 4) === "fmt ");
  check("has a data chunk", ascii(36, 4) === "data");

  check("RIFF size covers everything after byte 8", view.getUint32(4, true) === wav.byteLength - 8);
  check("fmt body is 16 bytes", view.getUint32(16, true) === 16);
  check("format is 1 (uncompressed PCM)", view.getUint16(20, true) === 1);
  check("declares mono", view.getUint16(22, true) === 1);
  check("declares 16 kHz", view.getUint32(24, true) === TARGET_SAMPLE_RATE, `${view.getUint32(24, true)}`);
  check("declares 16 bits per sample", view.getUint16(34, true) === 16);
  check("block align is 2 bytes", view.getUint16(32, true) === 2);
  check(
    "byte rate is rate x block align",
    view.getUint32(28, true) === TARGET_SAMPLE_RATE * 2,
    `${view.getUint32(28, true)}`,
  );
  check("data size matches the samples", view.getUint32(40, true) === samples.length * 2);
  check("total length is header + data", wav.byteLength === WAV_HEADER_BYTES + samples.length * 2);
}

{
  // Round trip: read the payload back out of the encoded file and confirm it is the same
  // signal, not a shifted or byte-swapped one.
  const samples = Int16Array.from([0, 1000, -1000, 32767, -32768]);
  const wav = encodeWav16(samples);
  const back = new Int16Array(
    wav.buffer.slice(wav.byteOffset + WAV_HEADER_BYTES, wav.byteOffset + wav.byteLength),
  );
  check("payload round-trips unchanged", Array.from(back).join(",") === Array.from(samples).join(","));
}

check("an empty recording still produces a valid 44-byte file", encodeWav16(new Int16Array(0)).byteLength === 44);

// ── Caps ──────────────────────────────────────────────────────────────────────────────
console.log("\ncaps");

check("wavByteLength agrees with the encoder", wavByteLength(1000) === encodeWav16(new Int16Array(1000)).byteLength);

{
  // The load-bearing sum: a recording at the cap must fit inside every ceiling downstream.
  // If MAX_RECORDING_MS is ever raised, this is the assertion that should stop it.
  const samples = msToSamples(MAX_RECORDING_MS);
  const raw = wavByteLength(samples);
  const encoded = base64ByteLength(raw);
  check(`a full ${MAX_RECORDING_MS / 60_000}-minute recording is ~${(raw / 1024 / 1024).toFixed(1)} MB`, raw < 12 * 1024 * 1024);
  check("…which is under Wispr's 25 MB request cap", raw < WISPR_MAX_BYTES, `${raw}`);
  // CAPTURE_MAX_UPLOAD_BYTES is 22 MB and is checked against the RAW file bytes in
  // bulk-notes-panel.tsx, but the server action body carries the base64 form, so both have
  // to clear.
  check("…and its base64 form is under the 22 MB upload budget", encoded < 22 * 1024 * 1024, `${encoded}`);
}

check("round trips ms → samples → ms", Math.abs(samplesToMs(msToSamples(30_000)) - 30_000) < 1);
check("the minimum is shorter than a real note", MIN_RECORDING_MS < 2_000);

// ── bytesToBase64 ─────────────────────────────────────────────────────────────────────
console.log("\nbytesToBase64");

{
  // Cross-checked against node's own encoder rather than against hand-written fixtures, so
  // the padding and the 6-bit regrouping are verified by an independent implementation.
  const cases: Uint8Array[] = [
    new Uint8Array(0),
    Uint8Array.from([0]),
    Uint8Array.from([0, 0]),
    Uint8Array.from([0, 0, 0]),
    Uint8Array.from([255, 254, 253, 252]),
    Uint8Array.from([...Array(256).keys()]),
    // A WAV header, i.e. the exact bytes this is really used on.
    encodeWav16(Int16Array.from([0, 1234, -1234])),
  ];
  for (const bytes of cases) {
    const mine = bytesToBase64(bytes);
    const theirs = Buffer.from(bytes).toString("base64");
    check(`matches node for ${bytes.length} bytes`, mine === theirs, `${mine} vs ${theirs}`);
  }
}

{
  // Every remainder-mod-3, which is where padding bugs live.
  for (const len of [1, 2, 3, 4, 5, 6, 7]) {
    const bytes = Uint8Array.from(Array.from({ length: len }, (_, i) => (i * 37) % 256));
    check(
      `padding is right at ${len} bytes`,
      bytesToBase64(bytes) === Buffer.from(bytes).toString("base64"),
    );
  }
}

{
  // The reason this is hand-rolled: btoa(String.fromCharCode(...bytes)) throws RangeError
  // well below this size, and a six-minute note is 11 MB. Crossing the internal chunk
  // boundary must not corrupt or drop a quad.
  const big = new Uint8Array(200_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 256;
  const mine = bytesToBase64(big);
  check("handles a payload far past the stack limit", mine === Buffer.from(big).toString("base64"));
  check("…at the expected encoded length", mine.length === base64ByteLength(big.length), `${mine.length}`);
}

// ── rmsLevel ──────────────────────────────────────────────────────────────────────────
console.log("\nrmsLevel");

check("silence reads zero", rmsLevel(new Float32Array(128)) === 0);
check("an empty frame reads zero", rmsLevel(new Float32Array(0)) === 0);

{
  const quiet = rmsLevel(sine(440, 16_000, 0.01, 0.01));
  const loud = rmsLevel(sine(440, 16_000, 0.01, 0.9));
  check("louder reads higher", loud > quiet, `${loud} vs ${quiet}`);
  check("stays within 0..1", loud <= 1 && quiet >= 0, `${loud}`);
  check("full scale does not exceed 1", rmsLevel(sine(440, 16_000, 0.01, 1)) <= 1);
}

{
  // The reason for the log curve: on a linear meter, ordinary speech sits so close to zero
  // that the bar never visibly moves. Anything around half amplitude should read as
  // clearly present, not as a twitch above the floor.
  const speechish = rmsLevel(sine(440, 16_000, 0.01, 0.5));
  check("half-amplitude speech reads as present", speechish > 0.4, `${speechish}`);
}

check("below the floor reads zero", rmsLevel(sine(440, 16_000, 0.01, 1e-6)) === 0);
check("the floor is a sane noise floor", FLOOR_DB < -30 && FLOOR_DB > -100);

// ── formatElapsed ─────────────────────────────────────────────────────────────────────
console.log("\nformatElapsed");

check("zero", formatElapsed(0) === "0:00");
check("pads seconds", formatElapsed(5_000) === "0:05");
check("rolls over at a minute", formatElapsed(60_000) === "1:00");
check("minutes and seconds", formatElapsed(95_000) === "1:35");
check("the cap", formatElapsed(MAX_RECORDING_MS) === "6:00");
check("truncates rather than rounding up", formatElapsed(1_999) === "0:01");
check("negative clamps to zero", formatElapsed(-5) === "0:00");

console.log("\nsmoke-voice-recording: all checks passed");
