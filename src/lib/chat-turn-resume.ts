/**
 * Picking a chat answer back up after the person left mid-turn.
 *
 * `/api/chat` finishes a new question on a saved thread whether or not anyone is still
 * reading the stream, and saves it on the thread. So a thread reopened mid-turn only has to
 * wait for the answer row to appear. Two signs that one is coming:
 *
 * - this tab sent it and the send has not settled (`inFlight`, module state, so it outlives
 *   the panel unmounting on a client-side navigation — and covers the seconds of retrieval
 *   before the question row is written);
 * - the thread's last row is a recent question from a streamed turn with nothing under it
 *   (another tab, or this one after a reload).
 *
 * ponytail: the answer appears when it lands rather than streaming live into the reopened
 * thread; replaying live tokens would need a shared buffer of the stream (Redis or similar).
 */

/** The route's `maxDuration` (60s) plus slack for retrieval and the save. */
export const RESUME_WINDOW_MS = 90_000;
export const RESUME_POLL_MS = 2_000;

/** A question this tab sent and has not heard the end of. */
export type LiveTurn = {
  startedAt: number;
  turnId: string;
  /** The send's own abort, so Stop on a reopened thread can end it like the original Stop. */
  controller?: AbortController;
  /**
   * How long this turn may still be running, when longer than `RESUME_WINDOW_MS`: a Deep
   * answer takes minutes. Only this tab knows a turn was Deep, so a turn found from its saved
   * question alone (a reload, another tab) still gets the ordinary window.
   */
  windowMs?: number;
};

/** A Deep answer is cut at 240s; this leaves room for it to be saved. */
export const DEEP_RESUME_WINDOW_MS = 270_000;

const inFlight = new Map<string, LiveTurn>();

export function markTurnInFlight(threadId: string, turn: LiveTurn): void {
  inFlight.set(threadId, turn);
}

/** Only the send that set it may clear it: a newer send on the same thread keeps its entry. */
export function clearTurnInFlight(threadId: string, turnId: string): void {
  if (inFlight.get(threadId)?.turnId === turnId) inFlight.delete(threadId);
}

/** The thread this tab most recently sent a still-unsettled question on, if any. */
export function inFlightThreadId(now = Date.now()): string | null {
  let best: [string, LiveTurn] | null = null;
  for (const entry of inFlight) {
    if (now - entry[1].startedAt < (entry[1].windowMs ?? RESUME_WINDOW_MS) && (!best || entry[1].startedAt > best[1].startedAt)) best = entry;
  }
  return best?.[0] ?? null;
}

type Row = { role: string; createdAt: Date | string; clientTurnId?: string | null };

/**
 * The turn still being written on this thread, if any: the turn id is what Stop marks
 * (`stopChatTurn`). Null when the answer has landed, failed, or the window has passed.
 */
export function pendingTurn(threadId: string, rows: readonly Row[], now = Date.now()): LiveTurn | null {
  const sent = inFlight.get(threadId);
  if (sent && now - sent.startedAt < (sent.windowMs ?? RESUME_WINDOW_MS)) return sent;
  const last = rows[rows.length - 1];
  if (!last || last.role !== "user" || !last.clientTurnId) return null;
  // A finalized voice utterance has no text-generation request waiting behind it.
  if (last.clientTurnId.startsWith("voice:")) return null;
  const startedAt = new Date(last.createdAt).getTime();
  return now - startedAt < RESUME_WINDOW_MS ? { startedAt, turnId: last.clientTurnId } : null;
}
