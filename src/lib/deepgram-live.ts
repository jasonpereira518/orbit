/**
 * One live Deepgram connection, from the browser.
 *
 * The token comes from our server and is good for opening this socket and nothing else; the
 * socket then outlives the token (Deepgram checks it only at the handshake), which is why a
 * meeting holds ONE connection rather than reconnecting on a timer — a reconnect restarts
 * Deepgram's speaker numbering.
 */
import { DEEPGRAM_MODEL } from "@/lib/deepgram-params";
import type { LiveWord } from "@/lib/speaker-map";

export type { LiveWord };

const LISTEN_URL = "wss://api.deepgram.com/v1/listen";

export type LiveResult = { text: string; final: boolean; startMs: number; endMs: number; words: LiveWord[] };

export type LiveHandle = {
  send: (pcm: Int16Array) => void;
  /** Flush Deepgram's buffer and wait for the last final result. */
  finish: () => Promise<void>;
  close: () => void;
  readonly openedAt: number;
};

type DeepgramMessage = {
  type?: string;
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: { transcript?: string; words?: { word: string; start: number; end: number; speaker?: number }[] }[];
  };
};

export async function openDeepgramLive(opts: {
  token: string;
  params: URLSearchParams;
  onResult: (result: LiveResult) => void;
  onClose: (code: number) => void;
  onError: () => void;
  socketFactory?: (url: string, protocols: string[]) => WebSocket;
}): Promise<LiveHandle> {
  const url = `${LISTEN_URL}?${opts.params.toString()}`;
  const make = opts.socketFactory ?? ((u, p) => new WebSocket(u, p));
  // Measured against the live API (2026-09-22 spike, see docs/.../task-1 findings):
  //   ["bearer", jwt]        -> opens.
  //   ["token", jwt]         -> closes immediately, code 1006. (This is what the plan drafted;
  //                             do not "simplify" back to it — it does not work.)
  //   ?access_token=<jwt>    -> closes 1006.
  //   ?token=<jwt>           -> closes 1006.
  //   ["token", rawApiKey]   -> opens, but is forbidden: the raw key must never reach a browser.
  // So the bearer subprotocol with the short-lived grant token is the only form that both
  // opens and keeps the raw key server-side.
  const socket = make(url, ["bearer", opts.token]);
  socket.binaryType = "arraybuffer";

  let finished: (() => void) | null = null;

  socket.onmessage = (event: MessageEvent) => {
    let payload: unknown;
    try {
      payload = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      return;
    }
    if (typeof payload !== "object" || payload === null) return;
    const message = payload as DeepgramMessage;

    // UtteranceEnd carries no transcript of its own; Metadata arrives once the stream is
    // fully flushed, which is what `finish()` is waiting on. Anything else unrecognized is
    // ignored rather than throwing — a malformed or future message type must not crash the
    // socket handler.
    if (message.type === "Metadata") {
      finished?.();
      return;
    }
    if (message.type === "UtteranceEnd") return;
    if (message.type && message.type !== "Results") return;

    const alt = message.channel?.alternatives?.[0];
    const text = typeof alt?.transcript === "string" ? alt.transcript.trim() : "";
    if (!text) return;

    const startMs = Math.round((message.start ?? 0) * 1000);
    const words: LiveWord[] = Array.isArray(alt?.words)
      ? alt.words
          .filter((w): w is { word: string; start: number; end: number; speaker?: number } => typeof w?.word === "string")
          .map((w) => ({
            word: w.word,
            start: Math.round((w.start ?? 0) * 1000),
            end: Math.round((w.end ?? 0) * 1000),
            speaker: typeof w.speaker === "number" ? w.speaker : null,
          }))
      : [];

    opts.onResult({
      text,
      final: Boolean(message.is_final),
      startMs,
      endMs: startMs + Math.round((message.duration ?? 0) * 1000),
      words,
    });
  };
  socket.onerror = () => opts.onError();
  socket.onclose = (event: CloseEvent) => {
    finished?.();
    opts.onClose(event.code);
  };

  await new Promise<void>((resolve, reject) => {
    // A handshake that finishes AFTER this fires must not leave a live connection nobody
    // holds the handle to — that is a leaked, billable stream. Close it before rejecting,
    // and clear the timer on the success path so it cannot fire once the caller already has
    // a handle.
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      reject(new Error("Deepgram socket timed out"));
    }, 10_000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    const failed = () => {
      clearTimeout(timer);
      reject(new Error(`Deepgram socket closed before opening (${DEEPGRAM_MODEL})`));
    };
    socket.addEventListener("close", failed, { once: true });
  });

  // `finish()` is called from both the reducer's stop path and its abort path in the next
  // task; memoizing the in-flight promise makes a second call join the first rather than
  // re-sending Finalize/CloseStream into an already-closing stream.
  let finishPromise: Promise<void> | null = null;

  return {
    openedAt: Date.now(),
    send(pcm: Int16Array) {
      if (socket.readyState === WebSocket.OPEN) socket.send(pcm.buffer as ArrayBuffer);
    },
    finish() {
      if (!finishPromise) {
        finishPromise = (async () => {
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify({ type: "Finalize" }));
          socket.send(JSON.stringify({ type: "CloseStream" }));
          await new Promise<void>((resolve) => {
            finished = resolve;
            setTimeout(resolve, 5_000);
          });
        })();
      }
      return finishPromise;
    },
    close() {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    },
  };
}
