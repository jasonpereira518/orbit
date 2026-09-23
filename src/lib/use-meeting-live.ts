"use client";

/**
 * A meeting's live Deepgram connection: the audio the recorder is already capturing, sent
 * on as it is captured, and finished sentences coming back a second later with speaker
 * labels.
 *
 * WHY THIS EXISTS. Meeting capture cuts ~minute-long chunks and uploads each to be
 * transcribed server-side. That works, and it is still the fallback, but the transcript
 * lags a minute and has no idea who said what. Streaming the same PCM straight to Deepgram
 * gives both: words within a second or two, and `diarize` telling us that two people spoke
 * — which `speaker-map.ts` turns into "you" and "speaker-2" using the microphone meter the
 * recorder already keeps.
 *
 * THE FALLBACK IS NOT OPTIONAL. A websocket that dies mid-meeting must not cost the user
 * those minutes, so the chunks keep being cut throughout and `LiveCoverageGate` decides,
 * chunk by chunk, whether the live path already covered it. While the socket is healthy
 * the chunks are binned; the moment it drops, the gap goes up the old route and this hook
 * redials with backoff. If Deepgram is off, refuses, or the plan does not include it,
 * nothing here runs at all and meeting capture behaves exactly as it did before.
 *
 * WHO OWNS `seq`. The browser does, through one counter shared with the chunk queue
 * (`nextSeq`). Live sentences and recovered chunks both draw from it, in the order things
 * happened, so `(session, seq)` stays unique and dense — dense matters, because the server
 * reports every hole between 0 and the highest seq as a minute of meeting that never
 * arrived. A chunk the live path covered never draws a number at all, which is why the
 * gate decides BEFORE the panel allocates one.
 *
 * TEARDOWN. Every exit — Stop, the three-hour cap, a spent quota, a fatal upload error,
 * Discard, unmounting mid-call — goes through `finish()` or `close()`, and both end with
 * the socket closed. A leaked socket keeps billing, so `close()` is idempotent, bumps a
 * generation counter that makes every in-flight callback a no-op, and runs from this
 * hook's own unmount cleanup as a backstop.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { openDeepgramLive, type LiveHandle, type LiveResult } from "@/lib/deepgram-live";
import { listenParams } from "@/lib/deepgram-params";
import { labelSpeakers, type LiveWord } from "@/lib/speaker-map";
import { LiveCoverageGate } from "@/lib/meeting-live-coverage";
import { TARGET_SAMPLE_RATE } from "@/lib/voice-recording";
import type { RecordedMeetingChunk } from "@/lib/use-meeting-recorder";

/** What `POST /api/capture/meetings/:id/stream-token` hands back. */
type StreamToken = {
  accessToken: string;
  expiresIn?: number;
  keyterms?: string[];
  remainingSeconds: number;
  warn: boolean;
};

export type LiveSegment = {
  seq: number;
  /** Meeting-relative, matching `MeetingChunk.startMs` — a resumed meeting's offset included. */
  startMs: number;
  endMs: number;
  /** "you" / "speaker-2", or null while there is not enough evidence to say. */
  speaker: string | null;
  text: string;
};

export type LiveStatus = "off" | "connecting" | "live" | "reconnecting";

/** Why live transcription is not going to happen for this meeting. */
export type LiveUnavailable =
  /** Wrong plan, Deepgram off, a refused grant — the chunk route carries the meeting. */
  | "unavailable"
  /** This month's meeting minutes are gone. The meeting has to stop. */
  | "quota";

export type UseMeetingLiveOptions = {
  /** The next transcript seq, from the counter the chunk queue also draws from. */
  nextSeq: () => number;
  /** Where this recorder sits on the meeting's timeline. A resumed meeting starts above 0. */
  offsetMs: () => number;
  /** The recorder's raw per-source loudness — how "you" is told from everyone else. */
  loudness: () => { micDominantShare: (startMs: number, endMs: number) => number | null };
  /** The recorder id the session was created or resumed with. */
  recorderId: () => string;
  /** A finished sentence. Already numbered, and posted with the next batch. */
  onSegment: (segment: LiveSegment, opts: { reconnected: boolean }) => void;
  /** Chunks the live path did not cover. Upload them the old way, oldest first. */
  onChunksNeeded: (chunks: RecordedMeetingChunk[]) => void;
  /** Live transcription is off for this meeting; say so once. */
  onUnavailable: (reason: LiveUnavailable) => void;
  /** 90% of the month's meeting minutes are gone. Fired at most once per meeting. */
  onQuotaWarning: (remainingSeconds: number) => void;
};

export type MeetingLiveHandle = {
  status: LiveStatus;
  /** The sentence being spoken right now, not yet final. "" when there is none. */
  interim: string;
  /**
   * A recording is starting. Zeroes the audio clock and begins buffering frames, so the
   * seconds spent creating the session and minting a token are still streamed. Called from
   * the click that starts the recorder, before any frame arrives.
   */
  reset: () => void;
  /** The session now exists: open the connection. Called once per recording. */
  start: (sessionId: string) => void;
  /** Every 16 kHz frame from the recorder. */
  pushFrame: (pcm: Int16Array) => void;
  /** A chunk the recorder just cut. Uploaded, held or binned by the coverage gate. */
  offerChunk: (chunk: RecordedMeetingChunk) => void;
  /** Stop: flush the last sentence, store it, hand back whatever the live path missed. */
  finish: () => Promise<void>;
  /** Tear down now, storing nothing and uploading nothing. Idempotent. */
  close: () => void;
};

/** Post finished sentences at least this often. Also flushed whenever a chunk is cut. */
const BATCH_EVERY_MS = 10_000;
/** Speaker labels get better as evidence accumulates; recomputing is cheap. */
const RELABEL_EVERY_MS = 10_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const MAX_RECONNECTS = 6;
/**
 * Audio held while the FIRST socket is being opened, so the opening seconds of a meeting
 * are streamed rather than skipped. Bounded well above the token fetch plus the socket's
 * own 10 s handshake timeout; past that the connection is not coming.
 */
const MAX_PREBUFFER_SAMPLES = TARGET_SAMPLE_RATE * 20;

export function useMeetingLive(options: UseMeetingLiveOptions): MeetingLiveHandle {
  const cb = useRef(options);
  useLayoutEffect(() => {
    cb.current = options;
  });

  const [status, setStatus] = useState<LiveStatus>("off");
  const [interim, setInterim] = useState("");

  const sessionRef = useRef<string | null>(null);
  const handleRef = useRef<LiveHandle | null>(null);
  /**
   * Bumped on every new connection attempt AND on teardown. A callback that can outlive its
   * connection — most importantly a dead socket's belated `onclose`, which arrives after we
   * have already dialed a replacement — compares against it and backs off. Same device as
   * `use-dictation.ts`, and for the same reason: the session id alone cannot tell two
   * connections within one meeting apart.
   */
  const genRef = useRef(0);
  /** True whenever no connection should exist. Our own closes must not read as drops. */
  const closedRef = useRef(true);
  const attemptRef = useRef(0);
  /**
   * Drops across the WHOLE recording, unlike `attemptRef`, which a successful connection
   * resets. A socket that opens cleanly and then dies every minute — or a segment route
   * that takes nothing, so every batch falls back — would otherwise redial for three hours,
   * minting tokens and billing Deepgram for audio no transcript ever keeps.
   */
  const dropsRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const batchTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Recorder-relative audio clock, from the sample count — the clock the chunker uses. */
  const audioMsRef = useRef(0);
  /** Where the CURRENT connection started streaming, recorder-relative. */
  const baseMsRef = useRef(0);
  /** End of the last sentence Deepgram confirmed, relative to the current connection. */
  const lastFinalMsRef = useRef(0);
  const gateRef = useRef(new LiveCoverageGate<RecordedMeetingChunk>());
  const wordsRef = useRef<LiveWord[]>([]);
  const labelsRef = useRef<Map<number, string>>(new Map());
  const labelledAtRef = useRef(0);
  const batchRef = useRef<LiveSegment[]>([]);
  const batchFailuresRef = useRef(0);
  /** The next sentence starts a new connection's numbering — the transcript says so. */
  const boundaryRef = useRef(false);
  const preRef = useRef<{ frames: Int16Array[]; samples: number } | null>(null);
  const quotaRef = useRef<{ remainingSeconds: number; fromMs: number } | null>(null);
  const quotaSpentRef = useRef(false);
  const warnedRef = useRef(false);

  /** Recorder-relative → meeting-relative, the clock chunks and stored segments share. */
  const meetingMs = useCallback((ms: number) => cb.current.offsetMs() + ms, []);

  const clearTimers = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    if (batchTimerRef.current) clearInterval(batchTimerRef.current);
    batchTimerRef.current = null;
  }, []);

  /** Close the socket and stop anything that could open another. Idempotent. */
  const close = useCallback(() => {
    closedRef.current = true;
    genRef.current += 1;
    clearTimers();
    const handle = handleRef.current;
    handleRef.current = null;
    if (handle) {
      try {
        handle.close();
      } catch {
        /* already closing */
      }
    }
    preRef.current = null;
    setInterim("");
    setStatus("off");
  }, [clearTimers]);

  /** Hand the gate's verdict to the panel: these chunks go up the old route. */
  const needChunks = useCallback((chunks: RecordedMeetingChunk[]) => {
    if (chunks.length) cb.current.onChunksNeeded(chunks);
  }, []);

  // Unmounting mid-meeting (an in-app navigation, a crashed render) must not leave a
  // billable connection open with nobody holding the handle. Anything the gate was holding
  // goes to the outbox on the way out: this hook is declared before the recorder, so its
  // cleanup runs first and the recorder's own final flush then finds the gate empty and
  // uploads straight through.
  useEffect(
    () => () => {
      needChunks(gateRef.current.release());
      close();
    },
    [close, needChunks],
  );

  /**
   * Post the sentences collected so far. On success the coverage watermark advances, which
   * is what lets the gate bin the chunks underneath them — so it advances only once the
   * text is actually stored, never merely because Deepgram said it.
   *
   * Returns false when the route has refused twice, which means the live path cannot store
   * anything and the meeting has to go back to chunks.
   */
  const flushBatch = useCallback(async (): Promise<boolean> => {
    const sessionId = sessionRef.current;
    const segments = batchRef.current;
    if (!sessionId || segments.length === 0) return true;
    batchRef.current = [];
    const coveredMs = meetingMs(baseMsRef.current + lastFinalMsRef.current);
    try {
      const res = await fetch(`/api/capture/meetings/${encodeURIComponent(sessionId)}/segments`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-orbit-recorder": cb.current.recorderId() },
        body: JSON.stringify({ segments }),
      });
      if (!res.ok) throw new Error(`segments-${res.status}`);
    } catch {
      batchFailuresRef.current += 1;
      // One blip is worth a retry with the next batch. A second means the route is not
      // going to take this meeting's text, and holding chunks against a watermark that will
      // never move would quietly lose the recording — so fall back to chunks instead.
      if (batchFailuresRef.current >= 2) return false;
      batchRef.current = [...segments, ...batchRef.current];
      return true;
    }
    batchFailuresRef.current = 0;
    gateRef.current.advance(coveredMs);
    return true;
  }, [meetingMs]);

  // `connect` retries itself, and the drop handler redials — both are cycles through
  // `connect`, so the backward edges go through refs.
  const dropRef = useRef<() => void>(() => {});
  const connectRef = useRef<(reconnect: boolean) => void>(() => {});

  const pumpBatch = useCallback(() => {
    void flushBatch().then((ok) => {
      if (!ok) dropRef.current();
    });
  }, [flushBatch]);

  const handleResult = useCallback(
    (result: LiveResult) => {
      if (!result.final) {
        setInterim(result.text);
        return;
      }
      setInterim("");

      const base = baseMsRef.current;
      for (const word of result.words) {
        wordsRef.current.push({ ...word, start: base + word.start, end: base + word.end });
      }
      // Labels improve as evidence accumulates — a speaker who has said twenty words is a
      // far better bet than one who has said three — so they are recomputed periodically
      // rather than pinned at first sight. Sentences already posted keep the label they had.
      const now = Date.now();
      if (now - labelledAtRef.current >= RELABEL_EVERY_MS) {
        labelledAtRef.current = now;
        labelsRef.current = labelSpeakers(wordsRef.current, cb.current.loudness());
      }

      const speakerId = dominantSpeaker(result.words);
      const speaker = speakerId === null ? null : (labelsRef.current.get(speakerId) ?? null);
      const segment: LiveSegment = {
        seq: cb.current.nextSeq(),
        startMs: Math.round(meetingMs(base + result.startMs)),
        endMs: Math.round(meetingMs(base + result.endMs)),
        speaker,
        text: result.text,
      };
      lastFinalMsRef.current = Math.max(lastFinalMsRef.current, result.endMs);
      batchRef.current.push(segment);

      const reconnected = boundaryRef.current;
      boundaryRef.current = false;
      cb.current.onSegment(segment, { reconnected });
    },
    [meetingMs],
  );

  /**
   * Mint a token and open one connection. `reconnect` separates the two very different
   * failure policies: the first attempt failing means this meeting simply does not get live
   * transcription (say so once, carry on with chunks), while a later one failing is a
   * dropped call worth redialing for.
   */
  const connect = useCallback(
    async (reconnect: boolean) => {
      const sessionId = sessionRef.current;
      if (!sessionId || closedRef.current) return;
      const generation = ++genRef.current;
      /** This attempt is no longer the current one. */
      const stale = () => genRef.current !== generation;
      const gone = () => stale() || closedRef.current;

      setStatus(reconnect ? "reconnecting" : "connecting");

      const retry = () => {
        if (gone()) return;
        if (!reconnect) {
          close();
          cb.current.onUnavailable("unavailable");
          return;
        }
        const attempt = ++attemptRef.current;
        if (attempt > MAX_RECONNECTS) {
          close();
          cb.current.onUnavailable("unavailable");
          return;
        }
        setStatus("reconnecting");
        const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          connectRef.current(true);
        }, wait);
      };

      let token: StreamToken;
      try {
        const res = await fetch(`/api/capture/meetings/${encodeURIComponent(sessionId)}/stream-token`, {
          method: "POST",
          headers: { "x-orbit-recorder": cb.current.recorderId() },
        });
        if (gone()) return;
        if (res.status === 402) {
          // The month's minutes are gone. The meeting stops through the panel's quota path,
          // which flushes and ends it properly rather than leaving it half-recorded.
          close();
          cb.current.onUnavailable("quota");
          return;
        }
        if (!res.ok) throw new Error(`stream-token-${res.status}`);
        token = (await res.json()) as StreamToken;
        if (gone()) return;
        if (!token?.accessToken) throw new Error("stream-token-empty");
      } catch {
        retry();
        return;
      }

      let handle: LiveHandle;
      try {
        handle = await openDeepgramLive({
          token: token.accessToken,
          params: listenParams({
            live: true,
            diarize: true,
            keyterms: token.keyterms,
            // The nightly reconciliation job matches Deepgram's usage records on exactly
            // this string. Without it that job silently reconciles nothing.
            tag: `meeting:${sessionId}`,
          }),
          // Results are accepted for as long as THIS connection is the current one, closed
          // or not: `finish()` marks the session closed before flushing, and the last
          // sentence arrives after that.
          onResult: (result) => {
            if (stale()) return;
            handleResult(result);
          },
          onClose: () => {
            if (gone()) return;
            dropRef.current();
          },
          onError: () => {
            if (gone()) return;
            dropRef.current();
          },
        });
      } catch {
        retry();
        return;
      }

      if (gone()) {
        // The handshake finished after we tore down. Nobody holds this handle, and an open
        // Deepgram stream bills for as long as it lives.
        handle.close();
        return;
      }

      // A first connection streams the audio buffered while it was being opened, so the
      // opening seconds of the meeting are transcribed rather than skipped. A RECONNECT
      // does not: that gap belongs to the chunk route, and Deepgram renumbers speakers on a
      // new socket anyway, so replaying old audio into it would only confuse the labels.
      const pre = preRef.current;
      preRef.current = null;
      let fromMs = audioMsRef.current;
      if (pre) {
        fromMs = audioMsRef.current - (pre.samples / TARGET_SAMPLE_RATE) * 1000;
        for (const frame of pre.frames) handle.send(frame);
      }

      handleRef.current = handle;
      baseMsRef.current = fromMs;
      lastFinalMsRef.current = 0;
      // Deepgram numbers speakers per connection, so evidence from the old one would label
      // the wrong people. Start again; sentences already posted keep their labels.
      wordsRef.current = [];
      labelsRef.current = new Map();
      labelledAtRef.current = 0;
      attemptRef.current = 0;
      batchFailuresRef.current = 0;
      quotaRef.current = { remainingSeconds: token.remainingSeconds, fromMs: audioMsRef.current };
      needChunks(gateRef.current.arm(meetingMs(fromMs)));
      setStatus("live");

      if (token.warn && !warnedRef.current) {
        warnedRef.current = true;
        cb.current.onQuotaWarning(token.remainingSeconds);
      }

      if (batchTimerRef.current) clearInterval(batchTimerRef.current);
      batchTimerRef.current = setInterval(pumpBatch, BATCH_EVERY_MS);
    },
    [close, handleResult, meetingMs, needChunks, pumpBatch],
  );

  /**
   * The socket dropped. Store what Deepgram already gave us, hand the gap to the chunk
   * route, then redial. The order matters: releasing before the flush would upload chunks
   * covering text we are about to store, and the transcript would carry it twice.
   */
  const handleDrop = useCallback(() => {
    if (closedRef.current) return;
    genRef.current += 1;
    if (batchTimerRef.current) clearInterval(batchTimerRef.current);
    batchTimerRef.current = null;
    const handle = handleRef.current;
    handleRef.current = null;
    if (handle) {
      try {
        handle.close();
      } catch {
        /* already gone */
      }
    }
    setInterim("");
    boundaryRef.current = true;
    const giveUp = ++dropsRef.current > MAX_RECONNECTS;
    setStatus(giveUp ? "off" : "reconnecting");
    const attempt = Math.max(1, attemptRef.current);
    attemptRef.current = attempt;
    void (async () => {
      await flushBatch();
      if (closedRef.current) return;
      needChunks(gateRef.current.release());
      if (giveUp) {
        close();
        cb.current.onUnavailable("unavailable");
        return;
      }
      const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        connectRef.current(true);
      }, wait);
    })();
  }, [close, flushBatch, needChunks]);

  useLayoutEffect(() => {
    dropRef.current = handleDrop;
    connectRef.current = (reconnect) => void connect(reconnect);
  });

  const reset = useCallback(() => {
    close();
    sessionRef.current = null;
    attemptRef.current = 0;
    dropsRef.current = 0;
    batchRef.current = [];
    batchFailuresRef.current = 0;
    wordsRef.current = [];
    labelsRef.current = new Map();
    labelledAtRef.current = 0;
    // The audio clock is per RECORDER, not per meeting: a resumed meeting's earlier minutes
    // are added back through `offsetMs()`, the same way the chunker does it.
    audioMsRef.current = 0;
    baseMsRef.current = 0;
    lastFinalMsRef.current = 0;
    boundaryRef.current = false;
    quotaRef.current = null;
    quotaSpentRef.current = false;
    warnedRef.current = false;
    gateRef.current.clear();
    preRef.current = { frames: [], samples: 0 };
  }, [close]);

  const start = useCallback(
    (sessionId: string) => {
      sessionRef.current = sessionId;
      closedRef.current = false;
      void connect(false);
    },
    [connect],
  );

  const pushFrame = useCallback((pcm: Int16Array) => {
    audioMsRef.current += (pcm.length / TARGET_SAMPLE_RATE) * 1000;

    const handle = handleRef.current;
    if (handle) {
      handle.send(pcm);
    } else {
      const pre = preRef.current;
      if (pre) {
        // A copy: the recorder hands the chunker the same array, and these frames outlive
        // this call.
        pre.frames.push(pcm.slice());
        pre.samples += pcm.length;
        while (pre.samples > MAX_PREBUFFER_SAMPLES && pre.frames.length > 1) {
          pre.samples -= pre.frames.shift()!.length;
        }
      }
    }

    const quota = quotaRef.current;
    if (quota && !quotaSpentRef.current && audioMsRef.current - quota.fromMs >= quota.remainingSeconds * 1000) {
      quotaSpentRef.current = true;
      cb.current.onUnavailable("quota");
    }
  }, []);

  const offerChunk = useCallback(
    (chunk: RecordedMeetingChunk) => {
      needChunks(gateRef.current.offer(chunk));
      // Timers are throttled to about once a minute in a background tab, which is where a
      // meeting spends its life. Chunk boundaries come off the audio clock instead, so this
      // keeps the watermark moving — and the held chunks down to one — regardless.
      if (handleRef.current) pumpBatch();
    },
    [needChunks, pumpBatch],
  );

  /** Stop. Flush Deepgram's buffer, store the last sentences, release the rest, close. */
  const finish = useCallback(async () => {
    const wasLive = !closedRef.current;
    // Set first: `handle.finish()` ends with the socket closing, and that close must read
    // as the end of the meeting rather than as a drop worth redialing for.
    closedRef.current = true;
    clearTimers();
    const handle = handleRef.current;
    if (wasLive && handle) {
      try {
        await handle.finish();
      } catch {
        /* the last sentence is lost; the chunk under it still covers that audio */
      }
    }
    await flushBatch();
    needChunks(gateRef.current.release());
    close();
  }, [clearTimers, close, flushBatch, needChunks]);

  return { status, interim, reset, start, pushFrame, offerChunk, finish, close };
}

/** Which of Deepgram's speakers said most of this sentence. */
function dominantSpeaker(words: readonly LiveWord[]): number | null {
  const counts = new Map<number, number>();
  for (const word of words) {
    if (word.speaker === null) continue;
    counts.set(word.speaker, (counts.get(word.speaker) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [speaker, count] of counts) {
    if (count > bestCount) {
      best = speaker;
      bestCount = count;
    }
  }
  return best;
}
