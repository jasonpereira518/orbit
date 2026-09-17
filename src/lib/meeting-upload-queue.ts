"use client";

/**
 * Gets every recorded meeting chunk to the server exactly once, whatever the network does.
 *
 * A chunk is written to an IndexedDB outbox BEFORE it is uploaded and removed only when the
 * server has acknowledged it. So a dropped connection, a crashed tab, or a laptop lid
 * closed mid-call costs nothing: the next recorder for that meeting (the same tab when the
 * network returns, or a new tab after a resume) finds the chunk and sends it. The server
 * side is idempotent on `(session, seq)`, so sending one twice is harmless.
 *
 * One upload at a time, in seq order. Transcription is the slow part and the server would
 * serialize a burst anyway; sending in order also means each chunk's transcription has the
 * previous chunk's text as context.
 *
 * Retries back off from 2s to a minute with jitter and honour `Retry-After`. Timers in a
 * background tab are throttled to about once a minute, so a retry can run late — but every
 * new chunk from the recorder also kicks the queue, and those arrive on the audio clock.
 *
 * Falls back to memory when IndexedDB is unavailable (some private windows): the meeting
 * still records, it just cannot survive a crash.
 */

export type ChunkUploadStatus = "queued" | "uploading" | "retrying" | "done" | "failed";

export type OutboxChunk = {
  sessionId: string;
  seq: number;
  startMs: number;
  endMs: number;
  silent: boolean;
  /** The WAV bytes; null for a silent chunk. */
  wav: ArrayBuffer | null;
};

export type ChunkResult = { seq: number; text: string; engine: string; duplicate: boolean };

export type QueueFatal =
  /** The server has no key to transcribe with — every chunk would fail the same way. */
  | "no-transcription-key"
  /** Another tab took this meeting over. */
  | "taken-over"
  /** The meeting was saved or discarded elsewhere, or no longer exists. */
  | "gone"
  | "signed-out";

export type MeetingUploadQueueOptions = {
  sessionId: string;
  recorderId: string;
  onResult: (result: ChunkResult) => void;
  onStatus: (seq: number, status: ChunkUploadStatus, detail?: string) => void;
  onFatal: (code: QueueFatal, message: string) => void;
};

const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
/** After this many failed attempts a chunk is parked as `failed`, so it cannot block the rest. */
const MAX_ATTEMPTS = 6;

export class MeetingUploadQueue {
  private readonly opts: MeetingUploadQueueOptions;
  private readonly pending = new Map<number, OutboxChunk>();
  private readonly writes = new Set<Promise<void>>();
  private readonly attempts = new Map<number, number>();
  private readonly failed = new Set<number>();
  private pumping = false;
  private stopped = false;
  private fatal: QueueFatal | null = null;
  private wakeAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idleWaiters: (() => void)[] = [];
  private readonly onOnline = () => this.kick();

  constructor(opts: MeetingUploadQueueOptions) {
    this.opts = opts;
    if (typeof window !== "undefined") window.addEventListener("online", this.onOnline);
  }

  /** Chunks not yet acknowledged, including parked failures. */
  get backlog(): number {
    return this.pending.size;
  }

  get failedCount(): number {
    return this.failed.size;
  }

  /** Persist first, then upload. Resolves once the chunk is safely in the outbox. */
  async enqueue(chunk: OutboxChunk): Promise<void> {
    if (this.stopped) return;
    // Tracked so `drain` can wait for it: Stop enqueues the final chunk and drains in the
    // same breath, and a drain that ran before this write landed would find the queue
    // empty and let the analysis start without the last minute of the meeting.
    const write: Promise<void> = outboxPut(chunk).then(
      () => undefined,
      // Memory still has it; losing crash-safety is better than losing the chunk.
      () => undefined
    );
    this.writes.add(write);
    try {
      await write;
    } finally {
      this.writes.delete(write);
    }
    this.pending.set(chunk.seq, chunk);
    this.opts.onStatus(chunk.seq, "queued");
    this.kick();
  }

  /**
   * Pick up whatever an earlier recorder for this meeting left in the outbox — a crashed
   * tab, a network that never came back. Returns the highest seq found, so a resumed
   * recorder numbers its chunks after them rather than on top of them.
   */
  async restore(): Promise<number> {
    const saved = await outboxList(this.opts.sessionId).catch(() => [] as OutboxChunk[]);
    let maxSeq = -1;
    for (const chunk of saved) {
      if (!this.pending.has(chunk.seq)) {
        this.pending.set(chunk.seq, chunk);
        this.opts.onStatus(chunk.seq, "queued");
      }
      maxSeq = Math.max(maxSeq, chunk.seq);
    }
    this.kick();
    return maxSeq;
  }

  /** Try the parked failures again. */
  retryFailed(): void {
    for (const seq of this.failed) {
      this.attempts.set(seq, 0);
      this.opts.onStatus(seq, "queued");
    }
    this.failed.clear();
    this.wakeAt = 0;
    this.kick();
  }

  /**
   * Resolve when nothing is left to send except parked failures, or after `timeoutMs`.
   * Returns true when fully drained.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    // Chunks still being written to the outbox are not in `pending` yet — see `enqueue`.
    // Yield once as well, so an `enqueue` called in the same tick has started its write.
    await Promise.resolve();
    await Promise.all([...this.writes]);
    if (this.isIdle()) return this.pending.size === 0;
    this.wakeAt = 0;
    this.kick();
    await Promise.race([
      new Promise<void>((resolve) => this.idleWaiters.push(resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    return this.pending.size === 0;
  }

  /** Stop sending. The outbox is left as it is, for a later recorder to finish. */
  dispose(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (typeof window !== "undefined") window.removeEventListener("online", this.onOnline);
    this.resolveIdle();
  }

  /** Forget this meeting's outbox entirely — after a save or a discard. */
  static async clearSession(sessionId: string): Promise<void> {
    await outboxClear(sessionId).catch(() => {});
  }

  /**
   * What an earlier recorder left unsent for this meeting, without sending it. A resumed
   * recorder needs this BEFORE it starts: its chunk numbering and timeline have to begin
   * after these, and the click that starts it cannot wait on IndexedDB.
   */
  static async peek(sessionId: string): Promise<{ count: number; maxSeq: number; maxEndMs: number }> {
    const saved = await outboxList(sessionId).catch(() => [] as OutboxChunk[]);
    return {
      count: saved.length,
      maxSeq: saved.reduce((m, c) => Math.max(m, c.seq), -1),
      maxEndMs: saved.reduce((m, c) => Math.max(m, c.endMs), 0),
    };
  }

  private isIdle() {
    return !this.pumping && [...this.pending.keys()].every((seq) => this.failed.has(seq));
  }

  private resolveIdle() {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private kick() {
    if (this.stopped || this.fatal || this.pumping) return;
    const wait = this.wakeAt - Date.now();
    if (wait > 0) {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.kick();
        }, wait);
      }
      return;
    }
    void this.pump();
  }

  private next(): OutboxChunk | null {
    let best: OutboxChunk | null = null;
    for (const chunk of this.pending.values()) {
      if (this.failed.has(chunk.seq)) continue;
      if (!best || chunk.seq < best.seq) best = chunk;
    }
    return best;
  }

  private async pump() {
    this.pumping = true;
    try {
      while (!this.stopped && !this.fatal) {
        if (typeof navigator !== "undefined" && navigator.onLine === false) break;
        if (this.wakeAt > Date.now()) break;
        const chunk = this.next();
        if (!chunk) break;
        await this.send(chunk);
      }
    } finally {
      this.pumping = false;
    }
    if (this.isIdle()) this.resolveIdle();
    else this.kick();
  }

  private async send(chunk: OutboxChunk) {
    this.opts.onStatus(chunk.seq, "uploading");
    const params = new URLSearchParams({
      seq: String(chunk.seq),
      startMs: String(chunk.startMs),
      endMs: String(chunk.endMs),
    });
    if (chunk.silent || !chunk.wav) params.set("silent", "1");

    let res: Response;
    try {
      res = await fetch(
        `/api/capture/meetings/${encodeURIComponent(this.opts.sessionId)}/chunks?${params}`,
        {
          method: "POST",
          headers: { "content-type": "audio/wav", "x-orbit-recorder": this.opts.recorderId },
          body: chunk.silent || !chunk.wav ? null : chunk.wav,
        }
      );
    } catch {
      this.backoff(chunk, "Offline — will retry");
      return;
    }

    if (res.ok) {
      const body = (await res.json().catch(() => null)) as ChunkResult | null;
      await this.acknowledge(chunk);
      this.opts.onStatus(chunk.seq, "done");
      if (body) this.opts.onResult(body);
      return;
    }

    const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    const message = body?.error || `Upload failed (${res.status})`;
    switch (res.status) {
      case 401:
        this.fail("signed-out", "You were signed out — sign in again to keep recording");
        return;
      case 404:
      case 410:
        this.fail("gone", message);
        return;
      case 409:
        this.fail("taken-over", message);
        return;
      case 422:
        this.fail("no-transcription-key", message);
        return;
      case 400:
      case 413:
        // The chunk itself is bad; retrying will not change that. Drop it from the outbox.
        await this.acknowledge(chunk);
        this.opts.onStatus(chunk.seq, "failed", message);
        return;
      case 429: {
        const after = Number(res.headers.get("retry-after"));
        this.wakeAt = Date.now() + (Number.isFinite(after) && after > 0 ? after * 1000 : MIN_BACKOFF_MS);
        this.opts.onStatus(chunk.seq, "retrying", "Slowing down — too many requests");
        return;
      }
      default:
        this.backoff(chunk, message);
    }
  }

  private backoff(chunk: OutboxChunk, detail: string) {
    const n = (this.attempts.get(chunk.seq) ?? 0) + 1;
    this.attempts.set(chunk.seq, n);
    if (n >= MAX_ATTEMPTS) {
      this.failed.add(chunk.seq);
      this.opts.onStatus(chunk.seq, "failed", detail);
      return;
    }
    const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (n - 1));
    this.wakeAt = Date.now() + base * (0.75 + Math.random() * 0.5);
    this.opts.onStatus(chunk.seq, "retrying", detail);
  }

  private fail(code: QueueFatal, message: string) {
    this.fatal = code;
    this.opts.onFatal(code, message);
    this.resolveIdle();
  }

  private async acknowledge(chunk: OutboxChunk) {
    this.pending.delete(chunk.seq);
    this.attempts.delete(chunk.seq);
    this.failed.delete(chunk.seq);
    await outboxDelete(chunk.sessionId, chunk.seq).catch(() => {});
  }
}

// ── IndexedDB outbox ──────────────────────────────────────────────────────────────────
//
// Raw IndexedDB rather than a wrapper library: four operations on one store do not
// justify a dependency. Keyed by [sessionId, seq].

const DB_NAME = "orbit-meeting-outbox";
const STORE = "chunks";

let dbPromise: Promise<IDBDatabase> | null = null;

function openOutbox(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: ["sessionId", "seq"] });
        store.createIndex("session", "sessionId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openOutbox().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

function outboxPut(chunk: OutboxChunk) {
  return tx("readwrite", (s) => s.put(chunk));
}

function outboxDelete(sessionId: string, seq: number) {
  return tx("readwrite", (s) => s.delete([sessionId, seq]));
}

function outboxList(sessionId: string): Promise<OutboxChunk[]> {
  return tx("readonly", (s) => s.index("session").getAll(sessionId) as IDBRequest<OutboxChunk[]>);
}

function outboxClear(sessionId: string) {
  return tx("readwrite", (s) =>
    s.delete(IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]))
  );
}
