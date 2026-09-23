/**
 * The boundary between live transcription and the chunk-upload fallback.
 *
 * Every case here is one a real meeting hits: the socket lagging a second behind a chunk
 * it has in fact transcribed, a socket that dies mid-chunk, a reconnect that has covered
 * nothing yet, and a second drop after that. Uploading too much bills twice and doubles
 * the transcript; uploading too little loses words silently.
 *
 * Run: npx tsx scripts/smoke-meeting-live-coverage.ts
 */
import {
  LiveCoverageGate,
  chunkDisposition,
  type ChunkSpan,
} from "../src/lib/meeting-live-coverage";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** A chunk the way `MeetingChunker` cuts them: ~60 s, meeting-relative. */
function chunk(n: number): ChunkSpan & { seq: number } {
  return { seq: n, startMs: n * 60_000, endMs: (n + 1) * 60_000 };
}

// ── The pure decision ─────────────────────────────────────────────────────────────────

console.log("\nchunkDisposition");
{
  check(
    "no live connection at all uploads everything (Deepgram off — today's behaviour)",
    chunkDisposition(null, chunk(0)) === "upload" && chunkDisposition(null, chunk(7)) === "upload",
  );

  const healthy = { fromMs: 0, coveredMs: 59_200 };
  check(
    "a chunk straddling the watermark is HELD, not uploaded — the live path is a second behind",
    chunkDisposition(healthy, chunk(0)) === "hold",
  );
  check(
    "…and is dropped once the watermark passes its end",
    chunkDisposition({ fromMs: 0, coveredMs: 60_400 }, chunk(0)) === "drop",
  );
  check(
    "a chunk entirely before the watermark is dropped",
    chunkDisposition({ fromMs: 0, coveredMs: 600_000 }, chunk(3)) === "drop",
  );
  check(
    "a chunk ending exactly on the watermark is dropped",
    chunkDisposition({ fromMs: 0, coveredMs: 60_000 }, chunk(0)) === "drop",
  );
  check(
    "a chunk entirely after the watermark is held",
    chunkDisposition({ fromMs: 0, coveredMs: 10_000 }, chunk(5)) === "hold",
  );

  // The reconnect case: a new socket covers from 400 s on and has confirmed nothing yet.
  // The chunk being cut when it dropped reaches back before that, so only the chunk route
  // will ever transcribe its first half.
  const reconnected = { fromMs: 400_000, coveredMs: 400_000 };
  check(
    "a reconnect with no covered time yet still uploads the chunk reaching back into the gap",
    chunkDisposition(reconnected, { startMs: 360_000, endMs: 420_000 }) === "upload",
  );
  check(
    "…while a chunk wholly inside the new connection is held, not uploaded",
    chunkDisposition(reconnected, { startMs: 420_000, endMs: 480_000 }) === "hold",
  );
  check(
    "a chunk starting exactly at the reconnect point is held, not uploaded",
    chunkDisposition(reconnected, { startMs: 400_000, endMs: 460_000 }) === "hold",
  );
}

// ── The gate: a meeting's worth of events in order ────────────────────────────────────

console.log("\nLiveCoverageGate — a healthy meeting");
{
  const gate = new LiveCoverageGate<ReturnType<typeof chunk>>();
  check("before the socket opens, chunks upload", gate.offer(chunk(0)).length === 1);

  gate.arm(60_000); // the socket opened one chunk in
  check("arming reports nothing to upload when nothing is held", gate.heldCount === 0);

  check("the next chunk is held, not uploaded", gate.offer(chunk(1)).length === 0);
  check("…and is being held", gate.heldCount === 1);
  gate.advance(119_000); // Deepgram is a second behind
  check("a watermark inside the chunk keeps holding it", gate.heldCount === 1);
  gate.advance(120_500);
  check("a watermark past its end drops it, with no upload", gate.heldCount === 0);

  gate.offer(chunk(2));
  gate.advance(180_400);
  check("the steady state holds nothing and uploads nothing", gate.heldCount === 0);
  check("the covered mark is the last watermark", gate.coveredMs === 180_400);
}

console.log("\nLiveCoverageGate — a drop, a reconnect, and a second drop");
{
  const gate = new LiveCoverageGate<ReturnType<typeof chunk>>();
  gate.arm(0);
  gate.offer(chunk(0));
  gate.advance(60_400);
  gate.offer(chunk(1));
  gate.advance(119_000); // mid-chunk-1 when the socket dies

  // FIRST DROP. Chunk 1 is half-covered; the half after 119 s exists only in the chunk.
  const gap1 = gate.release();
  check("the drop hands back exactly the chunk the live path never finished", gap1.length === 1 && gap1[0].seq === 1);
  check("the drop stops the live path", gate.isLive === false);
  check("chunks cut during the outage upload", gate.offer(chunk(2)).length === 1);
  check("…and keep uploading for as long as it lasts", gate.offer(chunk(3)).length === 1);

  // RECONNECT part-way through chunk 4 (240 s–300 s), at 265 s.
  gate.arm(265_000);
  check("a reconnect covers nothing yet", gate.coveredMs === 265_000);
  const straddling = gate.offer(chunk(4));
  check(
    "the chunk straddling the reconnect uploads — its first half is the tail of the gap",
    straddling.length === 1 && straddling[0].seq === 4,
  );
  check("the chunk after it is held again", gate.offer(chunk(5)).length === 0);
  gate.advance(360_500);
  check("…and dropped once covered", gate.heldCount === 0);

  // SECOND DROP, mid-chunk-6.
  gate.offer(chunk(6));
  gate.advance(400_000);
  const gap2 = gate.release();
  check("a second drop opens a second gap, handed back the same way", gap2.length === 1 && gap2[0].seq === 6);
  check("after the second drop everything uploads again", gate.offer(chunk(7)).length === 1);
}

console.log("\nLiveCoverageGate — edges");
{
  const gate = new LiveCoverageGate<ReturnType<typeof chunk>>();
  gate.arm(0);
  gate.offer(chunk(0));
  gate.advance(120_000); // a late watermark covers a chunk that was still held
  check("a watermark that jumps past a held chunk drops it", gate.heldCount === 0);
  const nothing = gate.release();
  check("releasing with nothing held uploads nothing", nothing.length === 0);

  const gate2 = new LiveCoverageGate<ReturnType<typeof chunk>>();
  gate2.arm(0);
  gate2.advance(500_000);
  gate2.advance(10_000);
  check("the watermark never moves backwards", gate2.coveredMs === 500_000);

  const gate3 = new LiveCoverageGate<ReturnType<typeof chunk>>();
  gate3.arm(0);
  gate3.offer(chunk(0));
  gate3.offer(chunk(1));
  const both = gate3.release();
  check("several held chunks come back oldest first", both.length === 2 && both[0].seq === 0 && both[1].seq === 1);

  const gate4 = new LiveCoverageGate<ReturnType<typeof chunk>>();
  gate4.arm(0);
  gate4.offer(chunk(0));
  gate4.clear();
  check("a discarded meeting releases nothing and holds nothing", gate4.release().length === 0 && !gate4.isLive);
}

// ── The fallback must be untouched ────────────────────────────────────────────────────

console.log("\nDeepgram off");
{
  const gate = new LiveCoverageGate<ReturnType<typeof chunk>>();
  const uploaded: number[] = [];
  for (let n = 0; n < 10; n++) for (const c of gate.offer(chunk(n))) uploaded.push(c.seq);
  check(
    "with no connection ever armed, every chunk uploads in order",
    uploaded.length === 10 && uploaded.every((seq, i) => seq === i),
  );
  check("and nothing is ever held", gate.heldCount === 0);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll live-coverage checks passed");
process.exit(0);
