/**
 * The state machine behind a multi-file notes drop: one uploaded file becomes one capture
 * job, which becomes one meeting on one person's timeline.
 *
 * Pure — no React, no DOM, no `fetch` of its own — so `scripts/smoke-capture-fanout.ts` can
 * drive the whole thing with a stub uploader and assert the properties that matter.
 * `use-capture-fanout.ts` is the thin hook that binds it to component state.
 *
 * Two properties are worth stating because they are the reason this is a module and not a
 * `for` loop:
 *
 *   CONCURRENCY IS BOUNDED. Each upload transcribes inside its request, so twelve at once is
 *   twelve concurrent OCR jobs against the user's own provider key. Two at a time keeps the
 *   queue moving without turning a folder drop into a rate-limit incident.
 *
 *   A 429 NEVER LOSES A FILE. `RATE_LIMITS.capture` is 30 a minute and a large drop can
 *   still reach it. A refused upload goes back to `waiting` with the server's `Retry-After`
 *   and is retried — silently dropping it would be indistinguishable, to the person, from a
 *   meeting that never happened.
 */

export type FanoutStatus =
  | "pending"
  | "uploading"
  | "waiting"
  | "queued"
  | "failed"
  | "skipped";

export type FanoutEntry = {
  /** Stable client key. Never the filename — two files can share one. */
  id: string;
  label: string;
  bytes: number;
  status: FanoutStatus;
  /** The capture job this file became, once the upload lands. */
  jobId: string | null;
  /** YYYY-MM-DD, editable before the run starts. */
  anchorIso: string | null;
  anchorSource: "filename" | "mtime" | "none";
  error: string | null;
  /** Epoch ms this entry may next be attempted. Only set while `waiting`. */
  retryAt: number | null;
  attempts: number;
};

export const DEFAULT_FANOUT_CONCURRENCY = 2;
/** A 429 without a usable `Retry-After` still has to wait for something. */
export const FALLBACK_RETRY_MS = 15_000;
/** Past this many attempts a file is failed rather than retried forever. */
export const MAX_FANOUT_ATTEMPTS = 4;

export type UploadOutcome =
  | { ok: true; jobId: string }
  | { ok: false; error: string; status: number; retryAfterSec: number | null };

export type FanoutSummary = {
  total: number;
  queued: number;
  failed: number;
  pending: number;
  inFlight: number;
  waiting: number;
  done: boolean;
};

export function summarize(entries: readonly FanoutEntry[]): FanoutSummary {
  const by = (s: FanoutStatus) => entries.filter((e) => e.status === s).length;
  const pending = by("pending");
  const inFlight = by("uploading");
  const waiting = by("waiting");
  return {
    total: entries.length,
    queued: by("queued"),
    failed: by("failed"),
    pending,
    inFlight,
    waiting,
    done: pending === 0 && inFlight === 0 && waiting === 0,
  };
}

/**
 * Which entries may start right now.
 *
 * `waiting` entries rejoin the queue only once their `retryAt` has passed, which is what
 * makes the retry a backoff rather than a spin.
 */
export function readyEntries(
  entries: readonly FanoutEntry[],
  now: number,
  concurrency = DEFAULT_FANOUT_CONCURRENCY
): FanoutEntry[] {
  const inFlight = entries.filter((e) => e.status === "uploading").length;
  const slots = Math.max(0, concurrency - inFlight);
  if (!slots) return [];
  return entries
    .filter(
      (e) =>
        e.status === "pending" ||
        (e.status === "waiting" && (e.retryAt === null || e.retryAt <= now))
    )
    .slice(0, slots);
}

/** Apply an upload's outcome to one entry. Returns a new entry; never mutates. */
export function applyOutcome(
  entry: FanoutEntry,
  outcome: UploadOutcome,
  now: number
): FanoutEntry {
  const attempts = entry.attempts + 1;
  if (outcome.ok) {
    return { ...entry, status: "queued", jobId: outcome.jobId, error: null, retryAt: null, attempts };
  }

  // 429 is the only status worth waiting on. A 400 or 413 is about this file and will say
  // the same thing next time; retrying it just delays telling the person.
  const retryable = outcome.status === 429 && attempts < MAX_FANOUT_ATTEMPTS;
  if (retryable) {
    const waitMs = outcome.retryAfterSec != null ? outcome.retryAfterSec * 1000 : FALLBACK_RETRY_MS;
    return { ...entry, status: "waiting", error: outcome.error, retryAt: now + waitMs, attempts };
  }
  return { ...entry, status: "failed", error: outcome.error, retryAt: null, attempts };
}

export function markUploading(entry: FanoutEntry): FanoutEntry {
  return { ...entry, status: "uploading", error: null, retryAt: null };
}

/** Replace one entry by id. The list is small; a map would cost more than it saves. */
export function replaceEntry(
  entries: readonly FanoutEntry[],
  next: FanoutEntry
): FanoutEntry[] {
  return entries.map((e) => (e.id === next.id ? next : e));
}

/**
 * How many rate-limit tokens a drop of this size costs.
 *
 * Exists so the arithmetic is asserted rather than remembered: with `autoQueue` each file is
 * ONE token, and the budget is 30 a minute. Without it each file cost two, so twelve files
 * needed 24 of the 30, fifteen was exactly the ceiling, and the sixteenth was refused
 * mid-drop.
 */
export function rateLimitTokensFor(fileCount: number, autoQueue = true): number {
  return autoQueue ? fileCount : fileCount * 2;
}
