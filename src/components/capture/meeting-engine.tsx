"use client";

/**
 * The meeting recorder ENGINE: the recorder, the live socket, the upload queue and the
 * transcript. LAZY-LOADED — `meeting-session.tsx` (the always-mounted shell) imports this
 * file only once something needs it (`preloadMeetingEngine`), so none of it ships on pages
 * that never record. It renders nothing; it publishes its state to the shell through
 * `publishEngine`, and the setup form's state comes in from the shell as `form`.
 *
 * Held ABOVE the page so a meeting outlives the route. Everything that used to live inside
 * `MeetingCapturePanel` — the recorder, the live socket, the upload queue, the transcript —
 * lives here instead, so navigating to Contacts or Chat mid-call keeps recording. The panel
 * on /capture and the bottom-right widget (`MeetingWidget`) are two views of this one state.
 *
 * The phases, in order:
 *
 *   setup     → nothing in flight. The panel shows the form.
 *   live      → recording. The audio streams to Deepgram as it is captured (`use-meeting-live`)
 *               and sentences land a second or two behind the conversation. Chunks are still
 *               cut throughout as the recovery route.
 *   pausing   → Pause was pressed. The last sentence is flushed and the session marked ended.
 *   paused    → the share and mic are released. Resume re-asks for the share (a browser gate
 *               that needs a click) and carries on the same transcript and timeline.
 *   finishing → the user CONFIRMED the meeting is done. The queue is drained.
 *   analyzing → the transcript becomes a digest (`analyzeMeetingSession`).
 *
 * NOTHING EXTRACTS UNTIL THE USER SAYS SO. Stop, "Stop sharing" in Chrome's bar, the length
 * cap and a stopped quota all land in `paused`; only `finish()` moves on to analysis. The
 * digest is handed to /capture through `claimAnalysis`, not pushed — the analysis is always
 * STARTED from /capture (the page whose `maxDuration` is 300 s; a server action inherits the
 * limit of the page it is posted from), and it is collected whenever /capture next mounts.
 *
 * TWO PATHS, ONE NUMBERING. Live sentences and uploaded chunks are both segments of the
 * same transcript, and both draw their `seq` from `seqRef` — in the order things happened,
 * so the two can never claim the same number. A chunk the live path already covered is
 * thrown away by the coverage gate and never draws one at all.
 *
 * A meeting survives a crash too: the server has every sentence and every transcribed chunk,
 * and the IndexedDB outbox has every unsent one, so a lost tab ends in the "Unfinished
 * meeting" banner on the next visit.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import {
  analyzeMeetingSession,
  createMeetingSession,
  discardMeetingSession,
  endMeetingSession,
  loadMeetingTranscript,
  resumeMeetingSession,
} from "@/actions/meetings";
import type { ResumableMeeting } from "@/lib/meeting-sessions";
import { formatMeetingDuration } from "@/lib/format-meeting-duration";
import { formatElapsed } from "@/lib/format-elapsed";
import { MAX_MEETING_MS } from "@/lib/meeting-chunking";
import { MeetingUploadQueue, type QueueFatal } from "@/lib/meeting-upload-queue";
import {
  useMeetingRecorder,
  type MeetingRecorderEndReason,
  type MeetingRecorderHandle,
  type MeetingSurface,
  type RecordedMeetingChunk,
} from "@/lib/use-meeting-recorder";
import { useMeetingLive, type LiveSegment, type LiveUnavailable } from "@/lib/use-meeting-live";
import { monthWindow } from "@/lib/speech-limits";
import {
  publishEngine,
  type MeetingEngineSlice,
  type MeetingFormState,
  type MeetingPhase,
  type PendingAnalysis,
  type ResumeTarget,
  type SegmentView,
} from "@/components/capture/meeting-session";

// Mirrors the server's `MAX_USER_NOTES_CHARS` (meeting-digest, which a client module cannot
// import); the server trims anyway.
export const MAX_SIDE_NOTES_CHARS = 20_000;

/**
 * The notes box is not stored on the server — it travels with the summarize request — so
 * this browser copy is what survives a crash, a reload, or coming back to an unfinished
 * meeting. Every access is guarded: storage can be absent or full, and notes that fail to
 * persist are still sent if the tab lives.
 */
const notesKey = (sessionId: string) => `orbit:meeting-notes:${sessionId}`;

function readNotes(sessionId: string): string {
  try {
    const raw = localStorage.getItem(notesKey(sessionId));
    // An earlier build stored a JSON list of timed notes; fold those into plain text.
    if (raw?.startsWith("[")) {
      const list: unknown = JSON.parse(raw);
      if (Array.isArray(list)) return list.map((n) => (typeof n?.text === "string" ? n.text : "")).filter(Boolean).join("\n");
    }
    return raw ?? "";
  } catch {
    return "";
  }
}

function writeNotes(sessionId: string, notes: string) {
  try {
    if (notes.trim()) localStorage.setItem(notesKey(sessionId), notes);
    else localStorage.removeItem(notesKey(sessionId));
  } catch {
    // Quota or disabled storage — see above.
  }
}

/** What the tab-title effect puts in front of the page's own title. */
const TITLE_PREFIX_RE = /^(● Rec|⏸ Paused) \d+:\d{2}(?: · )?/;

/** How long Finish waits for the last chunks to upload before offering a way out. */
const DRAIN_TIMEOUT_MS = 120_000;

/** The timeline nothing has written to yet — the recorder handle arrives a render later. */
const NO_LOUDNESS = { micDominantShare: () => null };

/**
 * Live sentences stop numbering here, leaving the top of the range for chunk uploads.
 *
 * The server refuses any seq over `MAX_SEQ` (10,000) with a 400, and the upload queue treats
 * a 400 as "this chunk is bad" and parks it as failed rather than retrying — so a meeting
 * that spent every number on sentences would leave the recovery route with nowhere to
 * write, and BOTH paths would stop storing for the rest of the call. A normal three-hour
 * meeting runs to roughly 1,900 sentences and a very chatty one to about 7,500, against at
 * most ~180 chunks, so a thousand reserved numbers is far more than the chunks can ever
 * need and the live path gives up first, loudly, with the fallback intact.
 */
const LIVE_SEQ_CEILING = 9_000;

const FATAL_COPY: Record<QueueFatal, string> = {
  "no-transcription-key":
    "Orbit has no key to transcribe with. Add an OpenAI or Gemini key in Settings — this meeting is kept and can be resumed.",
  "transcription-refused": "This meeting is kept and can be resumed once that’s sorted.",
  "taken-over": "This meeting is being recorded in another tab now, so this one stopped.",
  gone: "This meeting was saved or discarded somewhere else.",
  "meeting-quota-spent":
    "You’ve used this month’s meeting hours. This meeting is kept and can be resumed once they reset.",
  "signed-out": "You were signed out. Sign in again — the meeting is kept and can be resumed.",
};

export const MeetingEngine = memo(function MeetingEngine({ form }: { form: MeetingFormState }) {
  const router = useRouter();
  const [phase, setPhase] = useState<MeetingPhase>("setup");
  // The setup form lives in the shell (the calendar nudge fills it before this file loads).
  const { title, attendeesText, includeMic } = form;
  const attendeeEmailsRef = form.emailsRef;
  const [segments, setSegments] = useState<Record<number, SegmentView>>({});
  const [fatal, setFatal] = useState<string | null>(null);
  const [drainStuck, setDrainStuck] = useState<{ backlog: number } | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [pendingAnalysis, setPendingAnalysis] = useState<PendingAnalysis | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [micLost, setMicLost] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [totalMs, setTotalMs] = useState(0);
  const [quotaWarnMinutes, setQuotaWarnMinutes] = useState<number | null>(null);
  /** Seqs that begin a new live connection — Deepgram renumbers speakers across one. */
  const [reconnectSeqs, setReconnectSeqs] = useState<number[]>([]);
  const [sideNotes, setSideNotes] = useState("");
  /**
   * Paused WITH the share and mic still open (Chrome's sharing bar and the mic light stay
   * on). Resume is then one click; false means they were released and Resume re-asks.
   */
  const [shareKept, setShareKept] = useState(false);

  // Declared BEFORE the recorder hook on purpose: on unmount React runs effect cleanups in
  // declaration order, so this flips first and the recorder's final `onEnd` (fired from its
  // own cleanup) knows not to start anything for a meeting nobody is looking at.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const sessionIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<string | null>(null);
  const queueRef = useRef<MeetingUploadQueue | null>(null);
  const recorderIdRef = useRef<string>("");
  const bufferRef = useRef<RecordedMeetingChunk[]>([]);
  const offsetRef = useRef(0);
  /** The meeting's length at the last time its recorder stopped. */
  const totalMsRef = useRef(0);
  const resumeRef = useRef<ResumeTarget | null>(null);
  const sourceRef = useRef<"display" | "mic">("display");
  /** Why the recorder is being stopped — only an explicit Finish goes on to analysis. */
  const endIntentRef = useRef<"pause" | "finish">("pause");
  const fatalRef = useRef(false);
  /** Mirrors of state the recorder's end callback needs to read at call time. */
  const phaseRef = useRef<MeetingPhase>("setup");
  const shareKeptRef = useRef(false);
  const pendingRef = useRef<PendingAnalysis | null>(null);
  /** The latest notes, for the async summarize that outlives the render that started it. */
  const notesRef = useRef("");
  /**
   * THE one transcript numbering for this meeting. Live sentences and uploaded chunks both
   * draw from it, in the order things happened, so `(session, seq)` is unique across the two
   * paths — and dense, which the server's "minutes that never arrived" check depends on. A
   * resumed meeting starts it after everything the last recorder stored.
   */
  const seqRef = useRef(0);
  const recorderRef = useRef<MeetingRecorderHandle | null>(null);
  /** Stop the recorder from a callback declared before it exists. */
  const stopRecorder = useRef<() => void>(() => {});
  /** Close the live socket from an unmount cleanup, which cannot depend on render values. */
  const liveCloseRef = useRef<() => void>(() => {});
  const quotaStoppedRef = useRef(false);
  const liveNoticedRef = useRef(false);

  const setSegment = useCallback((seq: number, patch: Partial<SegmentView>) => {
    setSegments((prev) => {
      const current = prev[seq] ?? { seq, startMs: 0, text: null, silent: false, status: "queued" as const };
      return { ...prev, [seq]: { ...current, ...patch } };
    });
  }, []);

  /**
   * Send one chunk, numbering it from the shared counter as it goes out.
   *
   * The number is allocated HERE rather than by the chunker, because a chunk the live path
   * already transcribed is never sent and must never claim a number — a number nothing
   * stores is a hole, and the server reads a hole as a minute of the meeting that went
   * missing. With Deepgram off this hands out exactly the chunker's own numbering: one
   * chunk, one number, in order.
   */
  const uploadChunk = useCallback(
    (chunk: RecordedMeetingChunk) => {
      const queue = queueRef.current;
      const id = sessionIdRef.current;
      if (!queue || !id) {
        bufferRef.current.push(chunk);
        return;
      }
      const seq = seqRef.current++;
      setSegment(seq, { startMs: chunk.startMs, silent: chunk.silent, status: "queued" });
      void queue.enqueue({
        sessionId: id,
        seq,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        silent: chunk.silent,
        wav: chunk.wav ? (chunk.wav.buffer as ArrayBuffer) : null,
      });
    },
    [setSegment]
  );

  const uploadChunks = useCallback(
    (chunks: RecordedMeetingChunk[]) => {
      for (const chunk of chunks) uploadChunk(chunk);
    },
    [uploadChunk]
  );

  const handleLiveSegment = useCallback(
    (segment: LiveSegment, { reconnected }: { reconnected: boolean }) => {
      if (reconnected) setReconnectSeqs((prev) => [...prev, segment.seq]);
      setSegment(segment.seq, {
        startMs: segment.startMs,
        text: segment.text,
        silent: false,
        status: "done",
        speaker: segment.speaker,
      });
    },
    [setSegment]
  );

  /** The month's meeting minutes, and the day they come back. */
  const quotaResetLabel = useMemo(
    () =>
      monthWindow(new Date()).resetsAt.toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
      }),
    []
  );

  const handleLiveUnavailable = useCallback(
    (reason: LiveUnavailable) => {
      if (reason === "quota" || reason === "quota-unknown") {
        if (quotaStoppedRef.current) return;
        quotaStoppedRef.current = true;
        // Meetings fail CLOSED: an allowance we could not read stops the recording too,
        // because carrying on up the chunk route spends the very key the check guards. The
        // copy differs because the facts do — saying the hours are gone when we never got to
        // look would be a lie the user cannot act on.
        toast.info(
          reason === "quota"
            ? `Recording stopped — you’ve used this month’s meeting hours, which reset on ${quotaResetLabel}`
            : "Recording stopped — Orbit couldn’t check your meeting hours, so it didn’t keep recording — try again in a moment"
        );
        // Pause is the honest end: the recorder flushes its last chunk, the live socket
        // flushes its last sentence, and the meeting waits for the user to finish it.
        stopRecorder.current();
        return;
      }
      if (liveNoticedRef.current) return;
      liveNoticedRef.current = true;
      toast.info("Live transcription is unavailable — this meeting will still be transcribed");
    },
    [quotaResetLabel]
  );

  const live = useMeetingLive({
    nextSeq: () => (seqRef.current >= LIVE_SEQ_CEILING ? null : seqRef.current++),
    offsetMs: () => offsetRef.current,
    loudness: () => recorderRef.current?.loudness ?? NO_LOUDNESS,
    recorderId: () => recorderIdRef.current,
    onSegment: handleLiveSegment,
    onChunksNeeded: uploadChunks,
    onUnavailable: handleLiveUnavailable,
    onQuotaWarning: (remainingSeconds) => setQuotaWarnMinutes(Math.max(1, Math.round(remainingSeconds / 60))),
  });
  // Stable across renders, unlike the handle object itself — so the callbacks below can
  // depend on them honestly.
  const { close: liveClose, finish: liveFinish, reset: liveReset, start: liveStart } = live;

  const stopForFatal = useRef<() => void>(() => {});

  const openQueue = useCallback(
    (id: string) => {
      queueRef.current?.dispose();
      const queue = new MeetingUploadQueue({
        sessionId: id,
        recorderId: recorderIdRef.current,
        onResult: (r) => setSegment(r.seq, { text: r.text, status: "done", detail: undefined }),
        onStatus: (seq, status, detail) => setSegment(seq, { status, detail }),
        onFatal: (code, message) => {
          fatalRef.current = true;
          // A refused key's message is the provider-specific copy from the server.
          setFatal(code === "transcription-refused" ? `${message}. ${FATAL_COPY[code]}` : FATAL_COPY[code] ?? message);
          stopForFatal.current();
        },
      });
      queueRef.current = queue;
      return queue;
    },
    [setSegment]
  );

  const showTranscript = useCallback(async (id: string) => {
    const res = await loadMeetingTranscript(id);
    if (!res.ok) return;
    setSegments((prev) => {
      const next = { ...prev };
      for (const s of res.transcript.segments) {
        next[s.seq] = { seq: s.seq, startMs: s.startMs, text: s.text, silent: !s.text, status: "done" };
      }
      return next;
    });
  }, []);

  const runAnalysis = useCallback(async (id: string, force = false) => {
    setPhase("analyzing");
    setAnalysisError(null);
    const started = startedAtRef.current ? new Date(startedAtRef.current) : new Date();
    const localDateIso = `${started.getFullYear()}-${String(started.getMonth() + 1).padStart(2, "0")}-${String(started.getDate()).padStart(2, "0")}`;
    const res = await analyzeMeetingSession(id, {
      force,
      localDateIso,
      notes: notesRef.current,
    });
    if (!mountedRef.current) return;
    if (!res.ok) {
      setAnalysisError(res.error);
      return;
    }
    // Held for /capture to collect — see the header. Back to setup so a later visit to the
    // tab does not show a stale meeting.
    const next = { analysis: res.analysis, sessionId: id };
    pendingRef.current = next;
    setPendingAnalysis(next);
    setPhase("setup");
  }, []);

  const claimAnalysis = useCallback(() => {
    const next = pendingRef.current;
    pendingRef.current = null;
    setPendingAnalysis(null);
    return next;
  }, []);

  /** Flush → close the live socket → end the session → drain the queue → analyze. */
  const finishMeeting = useCallback(
    async (total: number) => {
      const id = sessionIdRef.current;
      if (!id) {
        // Stopped before the session was even created: nothing reached the server.
        liveClose();
        setPhase("setup");
        return;
      }
      setPhase("finishing");
      setDrainStuck(null);
      // Before anything else: flush Deepgram's last sentence, store it, and hand back any
      // chunk it never covered so the drain below picks it up. This also closes the socket
      // — the one exit path where the meeting ends normally.
      await liveFinish();
      await endMeetingSession(id, total);
      const drained = (await queueRef.current?.drain(DRAIN_TIMEOUT_MS)) ?? true;
      if (!mountedRef.current || fatalRef.current) return;
      if (!drained) {
        setDrainStuck({ backlog: queueRef.current?.backlog ?? 0 });
        return;
      }
      await runAnalysis(id);
    },
    [liveClose, liveFinish, runAnalysis]
  );

  /** The recorder is down but the meeting is not over: flush, mark ended, wait. */
  const pauseMeeting = useCallback(
    async (total: number) => {
      const id = sessionIdRef.current;
      if (!id) {
        liveClose();
        setPhase("setup");
        return;
      }
      setPhase("pausing");
      try {
        await liveFinish();
        await endMeetingSession(id, total);
      } finally {
        if (mountedRef.current && !fatalRef.current) setPhase("paused");
      }
    },
    [liveClose, liveFinish]
  );

  const handleStarted = useCallback(
    async ({ surface, micActive }: { surface: MeetingSurface; micActive: boolean }) => {
      setPhase("live");
      setFatal(null);
      fatalRef.current = false;
      setMicLost(includeMic && !micActive);

      const target = resumeRef.current;
      let id: string;
      if (target) {
        const res = await resumeMeetingSession(target.id, recorderIdRef.current);
        if (!res.ok) {
          fatalRef.current = true;
          setFatal(res.error);
          stopForFatal.current();
          return;
        }
        id = res.id;
        startedAtRef.current = res.startedAtIso;
        if (target.reload) void showTranscript(id);
      } else {
        const res = await createMeetingSession({
          title: title.trim() || null,
          attendees: parseAttendees(attendeesText, attendeeEmailsRef.current),
          includesMic: micActive,
          captureSurface: surface,
          recorderId: recorderIdRef.current,
        });
        if (!res.ok) {
          fatalRef.current = true;
          setFatal(res.error);
          stopForFatal.current();
          return;
        }
        id = res.id;
        startedAtRef.current = res.startedAtIso;
      }

      sessionIdRef.current = id;
      // Before setSessionId, in the same batch: the persist effect must not write the empty
      // list over notes an earlier tab saved for this meeting.
      if (target?.reload) setSideNotes(readNotes(id));
      setSessionId(id);
      const queue = openQueue(id);
      if (target) await queue.restore();
      // Anything cut before the session existed — a very short meeting, in practice.
      const early = bufferRef.current;
      bufferRef.current = [];
      for (const chunk of early) uploadChunk(chunk);

      // Last, so the numbering reads in the order things happened: anything cut before the
      // session existed is numbered first, then the live sentences.
      liveStart(id);
    },
    [attendeeEmailsRef, attendeesText, includeMic, liveStart, openQueue, showTranscript, title, uploadChunk]
  );

  const handleEnd = useCallback(
    (reason: MeetingRecorderEndReason, elapsedMs: number) => {
      if (!mountedRef.current) return;
      // The share ended while paused with it kept — "Stop sharing" in Chrome's bar, or the
      // Stop sharing button. The meeting is already flushed and marked ended; all that changes is
      // that Resume must ask for the share again.
      if (shareKeptRef.current && (phaseRef.current === "paused" || phaseRef.current === "pausing")) {
        setShareKept(false);
        if (reason === "share-ended") toast.info("Sharing stopped — you’ll pick the tab again when you resume");
        return;
      }
      const total = offsetRef.current + elapsedMs;
      totalMsRef.current = total;
      setTotalMs(total);
      if (fatalRef.current) {
        // The upload queue hit something terminal (signed out, taken over, the meeting
        // gone). Nothing more will be stored, so close the socket rather than leave it
        // streaming audio nobody will ever read.
        liveClose();
        setPhase("setup");
        return;
      }
      if (reason === "share-ended") toast.info("Sharing stopped — your recording is paused, not lost");
      if (reason === "cap") toast.info(`Stopped at ${formatMeetingDuration(MAX_MEETING_MS)} — your recording was kept`);
      const intent = endIntentRef.current;
      endIntentRef.current = "pause";
      if (intent === "finish") void finishMeeting(total);
      else void pauseMeeting(total);
    },
    [finishMeeting, liveClose, pauseMeeting]
  );

  const recorder = useMeetingRecorder({
    // Every chunk goes to the live path first, which decides whether it is needed: binned
    // while the socket is healthy, uploaded when it covers a gap, and always uploaded when
    // there is no socket at all.
    onChunk: live.offerChunk,
    // The point of the whole task: audio reaches Deepgram frame by frame rather than a
    // minute at a time.
    onFrame: live.pushFrame,
    onStarted: (info) => void handleStarted(info),
    onEnd: handleEnd,
    onError: () => {
      liveClose();
      // A refused share on RESUME goes back to waiting, not to a blank form — the meeting
      // is still there.
      setPhase(resumeRef.current && !resumeRef.current.reload ? "paused" : "setup");
    },
    onMicLost: () => {
      setMicLost(true);
      toast.info("Recording without your microphone — only the call’s audio will be transcribed");
    },
  });

  useLayoutEffect(() => {
    recorderRef.current = recorder;
    stopForFatal.current = () => recorder.stop();
    stopRecorder.current = () => recorder.stop();
    liveCloseRef.current = live.close;
    notesRef.current = sideNotes;
    phaseRef.current = phase;
    shareKeptRef.current = shareKept;
  });

  // Keep the browser copy current. Keyed by session, so notes typed before the session
  // exists (the first second or two) are written the moment it does.
  useEffect(() => {
    if (sessionId) writeNotes(sessionId, sideNotes);
  }, [sessionId, sideNotes]);

  // After the recorder hook, so its final flush on unmount reaches a live queue first. The
  // socket is closed here too: the recorder's unmount flush runs `handleEnd`, which returns
  // early once unmounted and so never reaches the flush-and-close.
  useEffect(
    () => () => {
      liveCloseRef.current();
      queueRef.current?.dispose();
      queueRef.current = null;
    },
    []
  );

  const startRecording = (target: ResumeTarget | null, source: "display" | "mic" = "display") => {
    resumeRef.current = target;
    sourceRef.current = source;
    endIntentRef.current = "pause";
    recorderIdRef.current = crypto.randomUUID();
    bufferRef.current = [];
    setFatal(null);
    setAnalysisError(null);
    setQuotaWarnMinutes(null);
    quotaStoppedRef.current = false;
    liveNoticedRef.current = false;
    if (target) {
      offsetRef.current = target.offsetMs;
      // After everything the last recorder stored AND everything it left unsent, so a
      // resumed meeting never reuses a number the server already has.
      seqRef.current = target.startSeq;
      totalMsRef.current = Math.max(totalMsRef.current, target.offsetMs);
    } else {
      sessionIdRef.current = null;
      setSessionId(null);
      setSegments({});
      setSideNotes("");
      setReconnectSeqs([]);
      offsetRef.current = 0;
      totalMsRef.current = 0;
      seqRef.current = 0;
    }
    setOffsetMs(offsetRef.current);
    setTotalMs(totalMsRef.current);
    recorder.reset();
    // Zero the live path's audio clock and start buffering frames now, so the seconds spent
    // creating the session and minting a token are still streamed rather than skipped.
    liveReset();
    // Synchronous from the click all the way to `getDisplayMedia` — see the hook.
    recorder.start({
      includeMic,
      source,
      startSeq: target?.startSeq ?? 0,
      startOffsetMs: offsetRef.current,
    });
  };

  /**
   * Pause. By default the share and mic stay open, so Resume is one click; `release` lets
   * them go instead (the "choose a different tab" route, and Stop sharing while paused).
   */
  const pause = (opts: { release?: boolean } = {}) => {
    const id = sessionIdRef.current;
    if (opts.release || !id || !recorder.recording) {
      endIntentRef.current = "pause";
      recorder.stop();
      return;
    }
    // `recorder.pause()` emits the last partial chunk now; the clock stops with it.
    const total = offsetRef.current + recorder.pause();
    totalMsRef.current = total;
    setTotalMs(total);
    setShareKept(true);
    setPhase("pausing");
    void (async () => {
      try {
        // Same order as a stop: the chunk above reaches the live path first, then the
        // socket flushes its last sentence and closes.
        await liveFinish();
        await endMeetingSession(id, total);
      } finally {
        if (mountedRef.current && !fatalRef.current) setPhase("paused");
      }
    })();
  };

  /** Carry on after a pause that kept the share: no picker, a fresh clock at the meeting's total. */
  const resumeKeptShare = async (id: string) => {
    setFatal(null);
    fatalRef.current = false;
    setQuotaWarnMinutes(null);
    quotaStoppedRef.current = false;
    liveNoticedRef.current = false;
    recorderIdRef.current = crypto.randomUUID();
    bufferRef.current = [];
    offsetRef.current = totalMsRef.current;
    setOffsetMs(offsetRef.current);
    // The old queue holds the old recorder id, which `resumeMeetingSession` is about to
    // replace; chunks cut meanwhile wait in `bufferRef` for the new one. Its unsent parts
    // are still in the IndexedDB outbox and come back with `restore`.
    queueRef.current?.dispose();
    queueRef.current = null;
    liveReset();
    recorder.resume({ startSeq: seqRef.current, startOffsetMs: offsetRef.current });
    setPhase("live");
    setShareKept(false);
    const res = await resumeMeetingSession(id, recorderIdRef.current);
    if (!res.ok) {
      fatalRef.current = true;
      setFatal(res.error);
      stopForFatal.current();
      return;
    }
    startedAtRef.current = res.startedAtIso;
    const queue = openQueue(id);
    await queue.restore();
    const early = bufferRef.current;
    bufferRef.current = [];
    for (const chunk of early) uploadChunk(chunk);
    liveStart(id);
  };

  const resume = () => {
    const id = sessionIdRef.current;
    if (!id) return;
    if (recorder.state === "paused") {
      void resumeKeptShare(id);
      return;
    }
    startRecording({ id, startSeq: seqRef.current, offsetMs: totalMsRef.current, reload: false }, sourceRef.current);
  };

  const finish = () => {
    if (recorder.recording || recorder.state === "paused") {
      // Releases the share too, then `handleEnd` carries on to the summary.
      endIntentRef.current = "finish";
      shareKeptRef.current = false;
      setShareKept(false);
      recorder.stop();
    } else {
      void finishMeeting(totalMsRef.current);
    }
  };

  /** A meeting that exists on the server but is not recording in this tab. */
  const adoptForAnalysis = async (meeting: ResumableMeeting) => {
    setBusyAction("analyze");
    try {
      sessionIdRef.current = meeting.id;
      setSideNotes(readNotes(meeting.id));
      setSessionId(meeting.id);
      startedAtRef.current = meeting.startedAtIso;
      recorderIdRef.current = crypto.randomUUID();
      fatalRef.current = false;
      // A crashed tab left it "recording" under a recorder that no longer exists. Ending it
      // lets this tab drain that recorder's outbox, which the server only accepts once ended.
      await endMeetingSession(meeting.id, meeting.durationMs);
      const queue = openQueue(meeting.id);
      const found = await queue.restore();
      if (found >= 0) {
        setPhase("finishing");
        const drained = await queue.drain(DRAIN_TIMEOUT_MS);
        if (!mountedRef.current || fatalRef.current) return;
        if (!drained) {
          setDrainStuck({ backlog: queue.backlog });
          return;
        }
      }
      await runAnalysis(meeting.id);
    } finally {
      setBusyAction(null);
    }
  };

  const discard = async (id: string): Promise<boolean> => {
    if (!confirm("Discard this meeting? Its transcript is deleted and can't be recovered.")) return false;
    setBusyAction("discard");
    try {
      if (recorder.recording || recorder.state === "paused") {
        fatalRef.current = true; // suppress the pause that Stop would otherwise start
        shareKeptRef.current = false;
        setShareKept(false);
        recorder.stop();
      }
      // Nothing from here on is stored, so the socket has no reason to stay open — and an
      // open Deepgram stream bills for as long as it lives. `close()` also empties the
      // coverage gate: a discarded meeting's held chunks have nowhere to go.
      liveClose();
      queueRef.current?.dispose();
      queueRef.current = null;
      const res = await discardMeetingSession(id);
      await MeetingUploadQueue.clearSession(id);
      writeNotes(id, "");
      if (!res.ok) toast.error(res.error);
      else toast.success("Meeting discarded");
      sessionIdRef.current = null;
      setSessionId(null);
      setSegments({});
      setSideNotes("");
      setDrainStuck(null);
      setPhase("setup");
      fatalRef.current = false;
      router.refresh();
      return true;
    } finally {
      setBusyAction(null);
    }
  };

  const summarize = (force = false) => {
    if (sessionIdRef.current) void runAnalysis(sessionIdRef.current, force);
  };

  const retryFailedParts = () => queueRef.current?.retryFailed();

  const retryUpload = () => {
    setDrainStuck(null);
    queueRef.current?.retryFailed();
    void (async () => {
      const drained = await queueRef.current?.drain(DRAIN_TIMEOUT_MS);
      if (!mountedRef.current) return;
      const id = sessionIdRef.current;
      if (drained && id) await runAnalysis(id);
      else setDrainStuck({ backlog: queueRef.current?.backlog ?? 0 });
    })();
  };

  const ordered = useMemo(() => Object.values(segments).sort((a, b) => a.seq - b.seq), [segments]);
  // Memoized: the session re-renders on every interim revision and elapsed tick, and a
  // three-hour meeting is thousands of segments to rescan each time.
  const { failedCount, pendingCount, heardNothing } = useMemo(
    () => ({
      failedCount: ordered.filter((s) => s.status === "failed").length,
      pendingCount: ordered.filter((s) => s.status !== "done" && s.status !== "failed").length,
      heardNothing: ordered.length > 0 && ordered.every((s) => s.silent || (s.status === "done" && !s.text)),
    }),
    [ordered]
  );

  const runningTotal = phase === "live" ? offsetMs + recorder.elapsedMs : totalMs;

  // The tab strip says it is still recording while the user is in their call's tab. Next
  // rewrites `document.title` on every navigation, so the prefix is re-applied from the base
  // each second and each route change (a long-hidden tab throttles the seconds, not the
  // minutes).
  const pathname = usePathname();
  const titleSecond = Math.floor(runningTotal / 1000);
  useEffect(() => {
    const base = document.title.replace(TITLE_PREFIX_RE, "");
    const label = phase === "live" ? "● Rec" : phase === "paused" || phase === "pausing" ? "⏸ Paused" : null;
    // Next clears the title for a moment while it navigates; no separator after nothing.
    document.title = label ? `${label} ${formatElapsed(titleSecond * 1000)}${base ? ` · ${base}` : ""}` : base;
  }, [phase, titleSecond, pathname]);
  useEffect(
    () => () => {
      document.title = document.title.replace(TITLE_PREFIX_RE, "");
    },
    []
  );

  const slice: MeetingEngineSlice = {
    phase,
    shareKept,
    recorder,
    liveStatus: live.status,
    liveInterim: live.interim,
    offsetMs,
    totalMs: runningTotal,
    atCap: runningTotal >= MAX_MEETING_MS,
    segments: ordered,
    failedCount,
    pendingCount,
    heardNothing,
    reconnectSeqs,
    sessionId,
    fatal,
    drainStuck,
    analysisError,
    micLost,
    busyAction,
    quotaWarnMinutes,
    quotaResetLabel,
    sideNotes,
    setSideNotes: (v: string) => setSideNotes(v.slice(0, MAX_SIDE_NOTES_CHARS)),
    startRecording,
    pause,
    resume,
    finish,
    discard,
    adoptForAnalysis,
    summarize,
    retryUpload,
    retryFailedParts,
  };

  // Every render: the slice is rebuilt on each tick and interim revision, and the shell's
  // consumers read it through a store so this memoised component never re-renders because
  // of them.
  useLayoutEffect(() => {
    publishEngine({
      slice,
      flow: { busy: phase !== "setup", hasPendingAnalysis: pendingAnalysis !== null, claimAnalysis },
    });
  });
  useEffect(() => () => publishEngine(null), []);

  return null;
});

function parseAttendees(text: string, emails: Record<string, string> = {}): { name: string; email?: string }[] {
  return text
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((name) => {
      const email = emails[name.toLowerCase()];
      return email ? { name, email } : { name };
    });
}
