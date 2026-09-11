/**
 * Where a meeting recording is cut: after the target at the first pause, at the hard limit
 * when there is none, silence flagged rather than sent, and every sample accounted for.
 * Pure — the chunker takes int16 samples and never touches a device.
 * Run: npx tsx scripts/smoke-meeting-chunking.ts
 */
import { MEETING_CHUNK_MAX_BYTES } from "../src/lib/capture-limits";
import {
  FRAME_SAMPLES,
  MAX_MEETING_MS,
  MEETING_MAX_CHUNK_MS,
  MEETING_TARGET_CHUNK_MS,
  MeetingChunker,
  frameRms,
  maxChunkWavBytes,
  type MeetingChunk,
} from "../src/lib/meeting-chunking";
import {
  TARGET_SAMPLE_RATE,
  createDownsampler,
  downsampleTo16k,
  msToSamples,
} from "../src/lib/voice-recording";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const RATE = TARGET_SAMPLE_RATE;

/** "Speech": a 220 Hz tone at about -12 dBFS. */
function tone(ms: number, amplitude = 0.25): Int16Array {
  const n = msToSamples(ms);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 220 * i) / RATE));
  return out;
}

/** A room: low noise at about -60 dBFS, or exact digital zero. */
function hush(ms: number, amplitude = 0.001): Int16Array {
  const n = msToSamples(ms);
  const out = new Int16Array(n);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = Math.round(amplitude * 32767 * ((seed / 0x7fffffff) * 2 - 1));
  }
  return out;
}

/** Feed in small, uneven pieces, the way the worklet delivers them. */
function feed(chunker: MeetingChunker, samples: Int16Array, piece = 43): MeetingChunk[] {
  const out: MeetingChunk[] = [];
  for (let i = 0; i < samples.length; i += piece) out.push(...chunker.push(samples.subarray(i, i + piece)));
  return out;
}

function concat(...parts: Int16Array[]): Int16Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ── Size budget ──────────────────────────────────────────────────────────────────────

check(
  `the longest chunk (${MEETING_MAX_CHUNK_MS / 1000}s) fits the chunk route's byte cap`,
  maxChunkWavBytes() < MEETING_CHUNK_MAX_BYTES,
  `${maxChunkWavBytes()} >= ${MEETING_CHUNK_MAX_BYTES}`
);
check("…and Vercel's 4.5MB body limit", maxChunkWavBytes() < 4.5 * 1024 * 1024);
check("the chunk cap is under Wispr's six-minute ceiling", MEETING_MAX_CHUNK_MS < 6 * 60_000);
check("the target is shorter than the hard cut", MEETING_TARGET_CHUNK_MS < MEETING_MAX_CHUNK_MS);
check("a three-hour meeting is the cap", MAX_MEETING_MS === 3 * 60 * 60_000);

// ── frameRms ─────────────────────────────────────────────────────────────────────────

check("silence has zero RMS", frameRms(new Int16Array(FRAME_SAMPLES)) === 0);
{
  const r = frameRms(tone(20, 0.5));
  check("a half-scale sine has RMS ~0.354", Math.abs(r - 0.3536) < 0.01, String(r));
}

// ── Cuts at a pause after the target ──────────────────────────────────────────────────
{
  const chunker = new MeetingChunker();
  // 61s of speech, then a 1s pause, then more speech: the cut belongs in the pause.
  const audio = concat(tone(61_000), hush(1_000), tone(10_000));
  const chunks = feed(chunker, audio);
  check("one chunk is cut once a pause follows the target", chunks.length === 1, String(chunks.length));
  const c = chunks[0]!;
  const lenMs = (c.samples.length / RATE) * 1000;
  check("…inside the pause, not at the target", lenMs > 61_000 && lenMs < 62_000, `${lenMs}ms`);
  check("…after at least 400ms of quiet", lenMs >= 61_400, `${lenMs}ms`);
  check("…numbered from 0 and starting at 0", c.seq === 0 && c.startMs === 0);
  check("…with speech in it, so not silent", !c.silent);
  const rest = chunker.flush();
  check("flush emits the remainder", rest !== null && rest.seq === 1);
  check(
    "…and no sample is lost or doubled",
    c.samples.length + rest!.samples.length === audio.length,
    `${c.samples.length + rest!.samples.length} vs ${audio.length}`
  );
  check("…with a continuous timeline", rest!.startMs === c.endMs, `${rest!.startMs} vs ${c.endMs}`);
}

// ── Does not cut at a pause BEFORE the target ─────────────────────────────────────────
{
  const chunker = new MeetingChunker();
  const chunks = feed(chunker, concat(tone(20_000), hush(2_000), tone(20_000)));
  check("a pause before the target is not a cut", chunks.length === 0, String(chunks.length));
}

// ── Hard cut when nobody pauses ───────────────────────────────────────────────────────
{
  const chunker = new MeetingChunker();
  const chunks = feed(chunker, tone(200_000));
  check("continuous sound is cut at the hard limit", chunks.length === 2, String(chunks.length));
  check(
    "…exactly at 90s each",
    chunks.every((c) => c.samples.length === msToSamples(MEETING_MAX_CHUNK_MS)),
    chunks.map((c) => c.samples.length).join(",")
  );
  check("…with contiguous seqs", chunks[0]!.seq === 0 && chunks[1]!.seq === 1);
}

// ── Pause detection adapts to a noisy room ────────────────────────────────────────────
{
  const chunker = new MeetingChunker();
  // A café: -30 dBFS of noise under everything; speech at -12 dBFS; a pause is just noise.
  const noisy = (ms: number) => hush(ms, 0.03);
  const speech = (ms: number) => {
    const t = tone(ms);
    const n = noisy(ms);
    for (let i = 0; i < t.length; i++) t[i] = Math.max(-32768, Math.min(32767, t[i]! + n[i]!));
    return t;
  };
  const chunks = feed(chunker, concat(speech(60_500), noisy(1_000), speech(5_000)));
  const lenMs = chunks[0] ? (chunks[0].samples.length / RATE) * 1000 : 0;
  check(
    "a pause over café noise is still found (cut before the hard limit)",
    chunks.length === 1 && lenMs < 62_000,
    `${chunks.length} chunks, ${lenMs}ms`
  );
}

// ── Silence ──────────────────────────────────────────────────────────────────────────
{
  const chunker = new MeetingChunker();
  const chunks = feed(chunker, new Int16Array(msToSamples(95_000)));
  check("digital silence is still cut into chunks", chunks.length === 1);
  check("…flagged silent, so it is never sent for transcription", chunks[0]!.silent);
}
{
  const chunker = new MeetingChunker();
  const chunks = feed(chunker, hush(95_000));
  check("a quiet room (-60 dBFS) is silent too", chunks.length === 1 && chunks[0]!.silent);
}
{
  const chunker = new MeetingChunker();
  // One short sentence in a minute and a half of quiet — must NOT be dropped.
  const chunks = feed(chunker, concat(hush(40_000), tone(1_500, 0.05), hush(55_000)));
  check("one quiet sentence makes the chunk not silent", chunks.length === 1 && !chunks[0]!.silent);
}

// ── Resume: numbering and timeline continue ───────────────────────────────────────────
{
  const chunker = new MeetingChunker({ startSeq: 7, startOffsetMs: 420_000 });
  const chunks = feed(chunker, concat(tone(61_000), hush(1_000)));
  check("a resumed recorder continues the seq", chunks[0]?.seq === 7);
  check("…and the timeline", chunks[0]?.startMs === 420_000);
  check("elapsed counts only this recorder's audio", Math.abs(chunker.elapsedMs - 62_000) < 1);
  check("nextSeq advances", chunker.nextSeq === 8);
}

// ── Flush edge cases ─────────────────────────────────────────────────────────────────
{
  const chunker = new MeetingChunker();
  check("flushing an empty chunker emits nothing", chunker.flush() === null);
  chunker.push(tone(10).subarray(0, 17));
  const tail = chunker.flush();
  check("a partial frame is flushed, not dropped", tail !== null && tail.samples.length === 17);
}

// ── createDownsampler is the same filter as downsampleTo16k ───────────────────────────
for (const rate of [48_000, 44_100, 16_000]) {
  const buf = new Float32Array(rate / 10);
  for (let i = 0; i < buf.length; i++) buf[i] = 0.4 * Math.sin((2 * Math.PI * 330 * i) / rate);
  const a = downsampleTo16k(buf, rate);
  const b = createDownsampler(rate)(buf);
  check(
    `${rate / 1000}k: one whole buffer through either path is identical`,
    a.length === b.length && a.every((v, i) => v === b[i]),
    `${a.length} vs ${b.length}`
  );
}

// ── End to end from a real device rate, one 128-sample worklet frame at a time ─────────
for (const rate of [48_000, 44_100]) {
  const seconds = 60;
  const frames = Math.floor((rate * seconds) / 128);
  const frame = new Float32Array(128);
  const fill = (i: number) => {
    for (let j = 0; j < 128; j++) frame[j] = 0.3 * Math.sin((2 * Math.PI * 220 * (i * 128 + j)) / rate);
  };
  const expected = Math.floor((frames * 128 * RATE) / rate);

  // The stateless per-frame call is what the chunk boundary exposed: it drops each frame's
  // fractional tail. Pinned so the reason for `createDownsampler` stays on record.
  let lossy = 0;
  for (let i = 0; i < frames; i++) {
    fill(i);
    lossy += downsampleTo16k(frame, rate).length;
  }
  check(`${rate / 1000}k: per-frame downsampleTo16k loses samples`, lossy < expected - 100, `${lossy} vs ${expected}`);

  const chunker = new MeetingChunker();
  const downsample = createDownsampler(rate);
  let produced = 0;
  for (let i = 0; i < frames; i++) {
    fill(i);
    const out = downsample(frame);
    produced += out.length;
    chunker.push(out);
  }
  const last = chunker.flush()!;
  check(
    `${rate / 1000}k: createDownsampler keeps every sample (within one)`,
    Math.abs(produced - expected) <= 1,
    `${produced} vs ${expected}`
  );
  check(`${rate / 1000}k: …and all of them reach the chunk`, last.samples.length === produced);
  check(
    `${rate / 1000}k: a minute of audio is a minute on the timeline`,
    Math.abs(last.endMs - seconds * 1000) < 5,
    String(last.endMs)
  );
}

console.log("\nsmoke-meeting-chunking: all checks passed");
