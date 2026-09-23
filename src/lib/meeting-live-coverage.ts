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
 * How much of this chunk the live path never confirmed — the audio only an upload can
 * rescue. Zero when the whole chunk is already stored.
 */
export function uncoveredMs(live: LiveCoverage | null, chunk: ChunkSpan): number {
  if (!live) return chunk.endMs - chunk.startMs;
  return Math.max(0, chunk.endMs - Math.max(live.coveredMs, chunk.startMs));
}

/**
 * Uncovered audio shorter than this is not worth a chunk upload.
 *
 * An upload is all-or-nothing: the smallest unit either path can rescue is a whole ~60 s
 * chunk. So rescuing the last second of one costs a duplicate minute — stored again under a
 * higher seq, so the transcript shows it twice and out of order, the digest reads it twice,
 * and Deepgram is billed for it twice. Three seconds is about one short sentence: below it,
 * what would be lost is a fragment, and paying a duplicate minute for a fragment is the
 * worse trade in both directions.
 */
export const MIN_UNCOVERED_MS = 3_000;

/**
 * The whole decision. `live` is null when no connection covers this chunk at all — before
 * the first socket opens, after one drops, and whenever Deepgram is off — and then every
 * chunk uploads, which is exactly how meeting capture behaved before live transcription
 * existed.
 */
export function chunkDisposition(live: LiveCoverage | null, chunk: ChunkSpan): ChunkDisposition {
  if (!live) return "upload";
  // Reaches back before this connection by a material amount: that head was never streamed
  // to Deepgram (or went to a socket that died before returning it), so only this chunk can
  // carry it. A reconnect that lands a fraction of a second into a chunk is NOT that case —
  // uploading the whole minute to rescue half a second duplicates everything after it.
  if (live.fromMs - chunk.startMs >= MIN_UNCOVERED_MS) return "upload";
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
    // Only ever bins. A held chunk cannot turn into an upload here: the one route to
    // "upload" is the `fromMs` head test, and `fromMs` does not move within a connection.
    // So unlike `arm`, there is nothing to hand back.
    this.held = this.held.filter((chunk) => chunkDisposition(this.live, chunk) !== "drop");
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
    // Not "anything the watermark did not reach" — a socket that dies a second before a
    // chunk boundary leaves a second uncovered, and uploading the whole minute to rescue it
    // duplicates fifty-nine seconds of transcript and bills for them again.
    const out = this.held.filter((chunk) => uncoveredMs(this.live, chunk) >= MIN_UNCOVERED_MS);
    this.held = [];
    this.live = null;
    return out;
  }

  /** Forget everything without uploading — a discarded meeting. */
  clear(): void {
    this.held = [];
    this.live = null;
  }

  /**
   * Re-judge everything held against a NEW connection. Unlike `advance`, this can turn a
   * held chunk into an upload: the new connection's `fromMs` may sit well inside it, making
   * its head a gap only the chunk route can fill.
   */
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
