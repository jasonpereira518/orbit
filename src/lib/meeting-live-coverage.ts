/**
 * Which recorded chunks a meeting still has to upload, once the browser is streaming the
 * same audio to Deepgram live.
 *
 * Both paths transcribe the SAME microphone. While the socket is healthy the live path
 * wins — it is a second behind rather than a minute, and it knows who spoke — so the
 * ~minute-long chunks it has already covered are thrown away instead of uploaded. When the
 * socket drops, the chunks are the recovery route: the gap between the last sentence
 * Deepgram confirmed and the moment a new connection takes over has to be transcribed the
 * old way, or that stretch of the meeting is simply missing.
 *
 * Getting that boundary wrong is expensive in both directions — upload too much and every
 * minute is transcribed twice (paid for twice, and duplicated in the transcript); upload
 * too little and words are lost with nothing on screen to say so. So the decision is one
 * pure function over two numbers, and `scripts/smoke-meeting-live-coverage.ts` drives it.
 *
 * TWO numbers, not one. A single "watermark" cannot tell the healthy case from the gap
 * case, because in BOTH of them the last confirmed sentence sits somewhere inside the
 * chunk being judged:
 *
 *   `coveredMs` — the end of the last sentence Deepgram confirmed AND we stored. Audio at
 *     or before this is transcribed; a chunk that ends inside it is redundant.
 *   `fromMs`    — where the CURRENT connection started covering. Audio before this belongs
 *     to a gap (nothing was streaming, or an older connection's words never arrived), so a
 *     chunk reaching back past it carries audio only the chunk route will ever transcribe.
 *
 * Everything here is meeting-relative milliseconds — the same clock `MeetingChunk.startMs`
 * uses, including a resumed meeting's offset.
 *
 * Pure: no DOM, no network, no React. `LiveCoverageGate` adds the small amount of state
 * (which chunks are waiting on a verdict) the panel would otherwise carry itself.
 */

export type ChunkSpan = { startMs: number; endMs: number };

export type LiveCoverage = {
  /** Meeting time this connection began streaming from. */
  fromMs: number;
  /** End of the last confirmed, stored sentence. Never moves backwards. */
  coveredMs: number;
};

export type ChunkDisposition =
  /** Send it: it holds audio the live path did not, or will not, transcribe. */
  | "upload"
  /** Wait: the live path is still a second or two behind this chunk's end. */
  | "hold"
  /** Bin it: every word in it is already stored from the live stream. */
  | "drop";

/**
 * The whole decision. `live` is null when no connection covers this chunk at all — before
 * the first socket opens, after one drops, and whenever Deepgram is off — and then every
 * chunk uploads, which is exactly how meeting capture behaved before live transcription
 * existed.
 */
export function chunkDisposition(live: LiveCoverage | null, chunk: ChunkSpan): ChunkDisposition {
  if (!live) return "upload";
  // Reaches back before this connection: part of it was never streamed to Deepgram (or was
  // streamed to a socket that died before returning it), so only this chunk can carry it.
  if (chunk.startMs < live.fromMs) return "upload";
  if (chunk.endMs <= live.coveredMs) return "drop";
  // Inside the live stretch but ahead of the last confirmed sentence. Deepgram is simply
  // behind; holding costs one chunk of memory and saves a duplicate upload every minute.
  return "hold";
}

/**
 * `chunkDisposition` plus the chunks currently waiting on a verdict.
 *
 * Held chunks live in memory only, deliberately: the audio under them has already been
 * streamed and its sentences are posted to the server every few seconds, so the durable
 * copy is the server's. Writing ~2 MB of WAV to IndexedDB every minute to protect a couple
 * of seconds of exposure — and then having to decide, after a crash, whether the live path
 * had already stored it — buys nothing.
 */
export class LiveCoverageGate<T extends ChunkSpan> {
  private live: LiveCoverage | null = null;
  private held: T[] = [];

  /** True while a live connection is covering audio. */
  get isLive(): boolean {
    return this.live !== null;
  }

  /** End of the last confirmed sentence, or null when nothing is covering. */
  get coveredMs(): number | null {
    return this.live?.coveredMs ?? null;
  }

  /** How many chunks are waiting on a verdict. Expected to be 0 or 1. */
  get heldCount(): number {
    return this.held.length;
  }

  /**
   * A connection is now streaming, from `fromMs` on. Returns any chunk already waiting that
   * this connection cannot account for — the reconnect case, where a chunk cut during the
   * gap must go by the chunk route.
   */
  arm(fromMs: number): T[] {
    this.live = { fromMs, coveredMs: fromMs };
    return this.sweep();
  }

  /** Deepgram confirmed and we stored everything up to `coveredMs`. Monotonic. */
  advance(coveredMs: number): void {
    if (!this.live) return;
    if (coveredMs > this.live.coveredMs) this.live.coveredMs = coveredMs;
    this.sweep();
  }

  /** The recorder cut a chunk. Returns it when it has to be uploaded now, else nothing. */
  offer(chunk: T): T[] {
    const disposition = chunkDisposition(this.live, chunk);
    if (disposition === "upload") return [chunk];
    if (disposition === "hold") this.held.push(chunk);
    return [];
  }

  /**
   * The connection is gone (dropped, or the meeting is ending). Stop holding and hand back
   * everything the live path never confirmed, oldest first — the gap, for the chunk route.
   */
  release(): T[] {
    const covered = this.live?.coveredMs ?? Number.NEGATIVE_INFINITY;
    const out = this.held.filter((chunk) => chunk.endMs > covered);
    this.held = [];
    this.live = null;
    return out;
  }

  /** Forget everything without uploading — a discarded meeting. */
  clear(): void {
    this.held = [];
    this.live = null;
  }

  /** Drop what is now covered; return what now has to be uploaded. */
  private sweep(): T[] {
    const out: T[] = [];
    const keep: T[] = [];
    for (const chunk of this.held) {
      const disposition = chunkDisposition(this.live, chunk);
      if (disposition === "upload") out.push(chunk);
      else if (disposition === "hold") keep.push(chunk);
      // "drop": every word in it is already stored.
    }
    this.held = keep;
    return out;
  }
}
