"use client";

/**
 * Meeting capture: keep this tab open during a Zoom or Google Meet call, and when it ends
 * Orbit has the transcript, a summary, and the people, reminders, action items, blockers
 * and open questions — landing in the same review-and-save flow as every other capture.
 *
 * The phases, in order:
 *
 *   setup     → title, who's on the call, mic on/off, how to share the call's audio.
 *   live      → recording. Chunks go to the upload queue as they are cut; the transcript
 *               fills in about a minute behind the conversation.
 *   finishing → Stop was pressed. The last chunk is sent and the queue drained.
 *   analyzing → the transcript becomes a digest (`analyzeMeetingSession`).
 *   review    → the digest card, then `BulkNotesPanel` auto-extracts people and dates
 *               from the digest's notes, and everything is saved as one batch.
 *
 * A meeting survives this component: the server has every transcribed chunk and the
 * IndexedDB outbox has every unsent one, so leaving mid-call (or crashing) ends in a
 * "Resume" banner on the next visit rather than a lost meeting.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useTransform, type MotionValue } from "motion/react";
import { AudioLines, Headphones, Loader2, Mic, MonitorUp, RotateCcw, Square, TriangleAlert } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  analyzeMeetingSession,
  createMeetingSession,
  discardMeetingSession,
  endMeetingSession,
  loadMeetingTranscript,
  resumeMeetingSession,
  type MeetingAnalysis,
} from "@/actions/meetings";
import type { ResumableMeeting } from "@/lib/meeting-sessions";
import { BulkNotesPanel } from "@/components/chat/bulk-notes-panel";
import {
  MeetingSummaryCard,
  formatMeetingDuration,
  type SelectableMeetingItem,
} from "@/components/capture/meeting-summary-card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatElapsed } from "@/lib/voice-recording";
import { MAX_MEETING_MS } from "@/lib/meeting-chunking";
import {
  MeetingUploadQueue,
  type ChunkUploadStatus,
  type QueueFatal,
} from "@/lib/meeting-upload-queue";
import {
  useMeetingRecorder,
  type MeetingRecorderEndReason,
  type MeetingRecorderErrorCode,
  type MeetingSurface,
  type RecordedMeetingChunk,
} from "@/lib/use-meeting-recorder";
import { cn } from "@/lib/utils";

type Phase = "setup" | "live" | "finishing" | "analyzing" | "review";

type SegmentView = {
  seq: number;
  startMs: number;
  text: string | null;
  silent: boolean;
  status: ChunkUploadStatus;
  detail?: string;
};

/** How long Stop waits for the last chunks to upload before offering a way out. */
const DRAIN_TIMEOUT_MS = 120_000;

const ERROR_COPY: Record<MeetingRecorderErrorCode, { title: string; detail: string }> = {
  cancelled: {
    title: "Nothing was shared",
    detail: "The share picker was closed. Start again and pick your call's tab or screen.",
  },
  "no-audio": {
    title: "That share had no sound",
    detail:
      "Orbit got the picture but not the audio. Start again and turn on “Also share tab audio” (for a Meet tab) or “Also share system audio” (for the Zoom app, via Entire screen).",
  },
  "insecure-context": {
    title: "Recording needs a secure connection",
    detail: "Browsers only allow screen and audio capture over HTTPS or on localhost.",
  },
  unsupported: {
    title: "This browser can't record a call",
    detail: "Meeting capture needs Chrome, Edge, Arc or Brave on a computer.",
  },
  unknown: {
    title: "Recording didn't start",
    detail: "Something went wrong starting the capture. Try once more.",
  },
};

const FATAL_COPY: Record<QueueFatal, string> = {
  "no-transcription-key":
    "Orbit has no key to transcribe with. Add an OpenAI or Gemini key in Settings — this meeting is kept and can be resumed.",
  "taken-over": "This meeting is being recorded in another tab now, so this one stopped.",
  gone: "This meeting was saved or discarded somewhere else.",
  "signed-out": "You were signed out. Sign in again — the meeting is kept and can be resumed.",
};

const SURFACE_LABEL: Record<Exclude<MeetingSurface, null>, string> = {
  browser: "Listening to a browser tab",
  window: "Listening to a window",
  monitor: "Listening to your computer",
};

export function MeetingCapturePanel({
  resumable: resumableProp,
  hasApiKey,
  canTranscribe,
  captureSupported,
  onBusyChange,
  onAnalyzed,
}: {
  resumable: ResumableMeeting | null;
  /** A completion key, for the analysis. */
  hasApiKey: boolean;
  /** An OpenAI, Gemini or Wispr key, for transcription. Anthropic cannot transcribe. */
  canTranscribe: boolean;
  /**
   * Desktop Chromium. Without it a meeting can still be summarized — the banner works
   * anywhere — but not recorded.
   */
  captureSupported: boolean;
  /** True while a meeting is recording or being finished — the page locks its other tabs. */
  onBusyChange?: (busy: boolean) => void;
  /**
   * The new capture flow: hand the analysis over instead of mounting the review panel
   * here. The caller queues the durable job and renders the summary card itself.
   */
  onAnalyzed?: (analysis: MeetingAnalysis, sessionId: string) => void;
}) {
  const router = useRouter();
  const onAnalyzedRef = useRef(onAnalyzed);
  useEffect(() => {
    onAnalyzedRef.current = onAnalyzed;
  });
  const [phase, setPhase] = useState<Phase>("setup");
  const [title, setTitle] = useState("");
  const [attendeesText, setAttendeesText] = useState("");
  const [includeMic, setIncludeMic] = useState(true);
  const [segments, setSegments] = useState<Record<number, SegmentView>>({});
  const [fatal, setFatal] = useState<string | null>(null);
  const [drainStuck, setDrainStuck] = useState<{ backlog: number } | null>(null);
  const [analysis, setAnalysis] = useState<MeetingAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [items, setItems] = useState<SelectableMeetingItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [resumable, setResumable] = useState<ResumableMeeting | null>(resumableProp);
  // A fresh server answer (after `router.refresh()`) replaces the local one. Adjusted
  // during render, React's pattern for state derived from a changing prop.
  const [resumableSource, setResumableSource] = useState(resumableProp);
  if (resumableSource !== resumableProp) {
    setResumableSource(resumableProp);
    setResumable(resumableProp);
  }
  const [outboxPeek, setOutboxPeek] = useState<{ id: string; count: number; maxSeq: number; maxEndMs: number } | null>(null);
  const [micLost, setMicLost] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  /** Where on the meeting's timeline this recorder started — for the on-screen clock. */
  const [offsetMs, setOffsetMs] = useState(0);

  // Declared BEFORE the recorder hook on purpose: on unmount React runs effect cleanups in
  // declaration order, so this flips first and the recorder's final `onEnd` (fired from its
  // own cleanup) knows not to start analyzing a meeting nobody is looking at.
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
  const modeRef = useRef<"new" | "resume">("new");
  const fatalRef = useRef(false);

  useEffect(() => {
    onBusyChange?.(phase === "live" || phase === "finishing" || phase === "analyzing");
  }, [phase, onBusyChange]);

  // Where a resumed recording picks up: after whatever the server has AND whatever an
  // earlier tab left unsent. Worked out ahead of time, because the click that resumes has
  // to reach `getDisplayMedia` without awaiting anything first.
  useEffect(() => {
    if (!resumable) return;
    let cancelled = false;
    void MeetingUploadQueue.peek(resumable.id).then((peek) => {
      if (!cancelled) setOutboxPeek({ id: resumable.id, ...peek });
    });
    return () => {
      cancelled = true;
    };
  }, [resumable]);
  const resumePoint =
    resumable && outboxPeek?.id === resumable.id
      ? {
          startSeq: Math.max(resumable.lastSeq, outboxPeek.maxSeq) + 1,
          offsetMs: Math.max(resumable.durationMs, outboxPeek.maxEndMs),
          unsent: outboxPeek.count,
        }
      : null;

  const setSegment = useCallback((seq: number, patch: Partial<SegmentView>) => {
    setSegments((prev) => {
      const current = prev[seq] ?? { seq, startMs: 0, text: null, silent: false, status: "queued" as const };
      return { ...prev, [seq]: { ...current, ...patch } };
    });
  }, []);

  const enqueue = useCallback((chunk: RecordedMeetingChunk) => {
    const queue = queueRef.current;
    const id = sessionIdRef.current;
    if (!queue || !id) {
      bufferRef.current.push(chunk);
      return;
    }
    void queue.enqueue({
      sessionId: id,
      seq: chunk.seq,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      silent: chunk.silent,
      wav: chunk.wav ? (chunk.wav.buffer as ArrayBuffer) : null,
    });
  }, []);

  const handleChunk = useCallback(
    (chunk: RecordedMeetingChunk) => {
      setSegment(chunk.seq, { startMs: chunk.startMs, silent: chunk.silent, status: "queued" });
      enqueue(chunk);
    },
    [enqueue, setSegment]
  );

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
          setFatal(FATAL_COPY[code] ?? message);
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

  const runAnalysis = useCallback(
    async (id: string, force = false) => {
      setPhase("analyzing");
      setAnalysisError(null);
      const started = startedAtRef.current ? new Date(startedAtRef.current) : new Date();
      const localDateIso = `${started.getFullYear()}-${String(started.getMonth() + 1).padStart(2, "0")}-${String(started.getDate()).padStart(2, "0")}`;
      const res = await analyzeMeetingSession(id, { force, localDateIso });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setAnalysisError(res.error);
        return;
      }
      setAnalysis(res.analysis);
      setItems(toSelectable(res.analysis));
      if (onAnalyzedRef.current) {
        // Handed off: the caller owns what happens next. Back to setup so a return to
        // this tab does not show a stale review.
        onAnalyzedRef.current(res.analysis, id);
        setPhase("setup");
        return;
      }
      setPhase("review");
    },
    []
  );

  /** Stop → end the session → drain the queue → analyze. */
  const finishMeeting = useCallback(
    async (totalMs: number) => {
      const id = sessionIdRef.current;
      if (!id) {
        // Stopped before the session was even created: nothing reached the server.
        setPhase("setup");
        return;
      }
      setPhase("finishing");
      setDrainStuck(null);
      await endMeetingSession(id, totalMs);
      const drained = (await queueRef.current?.drain(DRAIN_TIMEOUT_MS)) ?? true;
      if (!mountedRef.current || fatalRef.current) return;
      if (!drained) {
        setDrainStuck({ backlog: queueRef.current?.backlog ?? 0 });
        return;
      }
      await runAnalysis(id);
    },
    [runAnalysis]
  );

  const handleStarted = useCallback(
    async ({ surface, micActive }: { surface: MeetingSurface; micActive: boolean }) => {
      setPhase("live");
      setFatal(null);
      fatalRef.current = false;
      setMicLost(includeMic && !micActive);

      let id: string;
      if (modeRef.current === "resume" && resumable) {
        const res = await resumeMeetingSession(resumable.id, recorderIdRef.current);
        if (!res.ok) {
          fatalRef.current = true;
          setFatal(res.error);
          stopForFatal.current();
          return;
        }
        id = res.id;
        startedAtRef.current = res.startedAtIso;
        void showTranscript(id);
      } else {
        const res = await createMeetingSession({
          title: title.trim() || null,
          attendees: parseAttendees(attendeesText),
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
      setSessionId(id);
      const queue = openQueue(id);
      if (modeRef.current === "resume") await queue.restore();
      // Anything cut before the session existed — a very short meeting, in practice.
      const early = bufferRef.current;
      bufferRef.current = [];
      for (const chunk of early) enqueue(chunk);
    },
    [attendeesText, enqueue, includeMic, openQueue, resumable, showTranscript, title]
  );

  const handleEnd = useCallback(
    (reason: MeetingRecorderEndReason, elapsedMs: number) => {
      if (!mountedRef.current) return;
      if (fatalRef.current) {
        setPhase("setup");
        return;
      }
      if (reason === "share-ended") toast.info("Sharing stopped — your recording was kept");
      if (reason === "cap") toast.info(`Stopped at ${formatMeetingDuration(MAX_MEETING_MS)} — your recording was kept`);
      void finishMeeting(offsetRef.current + elapsedMs);
    },
    [finishMeeting]
  );

  const recorder = useMeetingRecorder({
    onChunk: handleChunk,
    onStarted: (info) => void handleStarted(info),
    onEnd: handleEnd,
    onError: () => setPhase("setup"),
    onMicLost: () => {
      setMicLost(true);
      toast.info("Recording without your microphone — only the call’s audio will be transcribed");
    },
  });

  useLayoutEffect(() => {
    stopForFatal.current = () => recorder.stop();
  });

  // After the recorder hook, so its final flush on unmount reaches a live queue first.
  useEffect(
    () => () => {
      queueRef.current?.dispose();
      queueRef.current = null;
    },
    []
  );

  function startRecording(mode: "new" | "resume") {
    if (mode === "resume" && (!resumable || !resumePoint)) return;
    modeRef.current = mode;
    recorderIdRef.current = crypto.randomUUID();
    bufferRef.current = [];
    setFatal(null);
    setAnalysis(null);
    setAnalysisError(null);
    if (mode === "new") {
      sessionIdRef.current = null;
      setSessionId(null);
      setSegments({});
      offsetRef.current = 0;
    } else {
      offsetRef.current = resumePoint!.offsetMs;
    }
    setOffsetMs(offsetRef.current);
    recorder.reset();
    // Synchronous from the click all the way to `getDisplayMedia` — see the hook.
    recorder.start({
      includeMic,
      startSeq: mode === "resume" ? resumePoint!.startSeq : 0,
      startOffsetMs: offsetRef.current,
    });
  }

  /** A meeting that exists on the server but is not recording in this tab. */
  async function adoptForAnalysis(meeting: ResumableMeeting) {
    setBusyAction("analyze");
    try {
      sessionIdRef.current = meeting.id;
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
  }

  async function discard(id: string) {
    if (!confirm("Discard this meeting? Its transcript is deleted and can't be recovered.")) return;
    setBusyAction("discard");
    try {
      if (recorder.recording) {
        fatalRef.current = true; // suppress the analyze that Stop would otherwise start
        recorder.stop();
      }
      queueRef.current?.dispose();
      queueRef.current = null;
      const res = await discardMeetingSession(id);
      await MeetingUploadQueue.clearSession(id);
      if (!res.ok) toast.error(res.error);
      else toast.success("Meeting discarded");
      sessionIdRef.current = null;
      setSessionId(null);
      setSegments({});
      setAnalysis(null);
      setResumable(null);
      setDrainStuck(null);
      setPhase("setup");
      fatalRef.current = false;
      router.refresh();
    } finally {
      setBusyAction(null);
    }
  }

  const ordered = useMemo(
    () => Object.values(segments).sort((a, b) => a.seq - b.seq),
    [segments]
  );
  const failedCount = ordered.filter((s) => s.status === "failed").length;
  const pendingCount = ordered.filter((s) => s.status !== "done" && s.status !== "failed").length;
  const heardNothing =
    ordered.length > 0 && ordered.every((s) => s.silent || (s.status === "done" && !s.text));

  // ── Review ─────────────────────────────────────────────────────────────────────────
  if (phase === "review" && analysis && sessionId) {
    const extraReminders = items
      .filter((i) => i.checked && i.title.trim())
      .map((i) => ({
        kind: i.kind,
        title: i.title.trim(),
        ownerName: i.owner && i.owner !== "me" ? i.owner : null,
        sourceExcerpt: i.sourceExcerpt,
      }));
    return (
      <BulkNotesPanel
        key={`meeting-${sessionId}`}
        initialNotes={analysis.corpus}
        initialHints={analysis.hints}
        autoExtract
        parseOptions={{ meetingSessionId: sessionId }}
        meeting={{ sessionId, extraReminders }}
        hasApiKey={hasApiKey}
        headerSlot={
          <div className="space-y-2">
            <MeetingSummaryCard
              meeting={{
                title: analysis.digest.title || title || "Meeting",
                summary: analysis.digest.summary,
                keyPoints: analysis.digest.keyPoints,
                decisions: analysis.digest.decisions,
                actionItems: analysis.digest.actionItems,
                blockers: analysis.digest.blockers,
                openQuestions: analysis.digest.openQuestions,
                durationMs: analysis.durationMs,
                startedAtIso: analysis.startedAtIso,
              }}
              items={items}
              onItemsChange={setItems}
              sessionId={sessionId}
            />
            {analysis.missingSeqs.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {analysis.missingSeqs.length} minute{analysis.missingSeqs.length === 1 ? "" : "s"} of this
                meeting never reached Orbit, so they are not in the summary.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={busyAction !== null}
                onClick={() => void runAnalysis(sessionId, true)}
              >
                <RotateCcw className="size-3.5" /> Re-analyze
              </Button>
            </div>
          </div>
        }
        // Back to the start, not a discard: the meeting stays on the server and comes back
        // as the resume banner, digest and all.
        onStartOver={() => {
          setAnalysis(null);
          setPhase("setup");
          router.refresh();
        }}
        onSaved={(res) => {
          void MeetingUploadQueue.clearSession(sessionId);
          router.push(`/capture/${res.batchId}`);
        }}
      />
    );
  }

  // ── Finishing / analyzing ──────────────────────────────────────────────────────────
  if (phase === "finishing" || phase === "analyzing") {
    return (
      <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
        {analysisError ? (
          <div role="alert" className="space-y-3">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <TriangleAlert className="size-4 text-destructive" /> Couldn&apos;t summarize the meeting
            </p>
            <p className="text-sm text-muted-foreground">{analysisError}</p>
            <p className="text-sm text-muted-foreground">The transcript is saved — nothing is lost.</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => sessionId && void runAnalysis(sessionId, true)}>Try again</Button>
              <Button variant="ghost" onClick={() => sessionId && void discard(sessionId)}>
                Discard meeting
              </Button>
            </div>
          </div>
        ) : drainStuck ? (
          <div role="alert" className="space-y-3">
            <p className="font-medium text-foreground">
              {drainStuck.backlog} part{drainStuck.backlog === 1 ? "" : "s"} of the meeting haven&apos;t uploaded yet
            </p>
            <p className="text-sm text-muted-foreground">
              They are saved in this browser and will keep trying. You can wait, or summarize what has
              arrived so far.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setDrainStuck(null);
                  queueRef.current?.retryFailed();
                  void (async () => {
                    const drained = await queueRef.current?.drain(DRAIN_TIMEOUT_MS);
                    if (!mountedRef.current) return;
                    if (drained && sessionId) await runAnalysis(sessionId);
                    else setDrainStuck({ backlog: queueRef.current?.backlog ?? 0 });
                  })();
                }}
              >
                Retry upload
              </Button>
              <Button onClick={() => sessionId && void runAnalysis(sessionId)}>Summarize anyway</Button>
            </div>
          </div>
        ) : (
          <div aria-live="polite" className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin text-primary" />
            {phase === "finishing"
              ? pendingCount > 0
                ? `Finishing the transcript — ${pendingCount} part${pendingCount === 1 ? "" : "s"} left…`
                : "Finishing the transcript…"
              : "Summarizing the meeting and pulling out people, next steps, blockers and questions…"}
          </div>
        )}
        {ordered.length > 0 && <TranscriptList segments={ordered} compact />}
      </div>
    );
  }

  // ── Live ───────────────────────────────────────────────────────────────────────────
  if (phase === "live" || recorder.state === "requesting") {
    const elapsed = offsetMs + recorder.elapsedMs;
    const nearCap = MAX_MEETING_MS - elapsed < 5 * 60_000;
    return (
      <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
        {recorder.state === "requesting" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <Loader2 className="size-4 animate-spin" /> Pick your call&apos;s tab or screen, and turn on its audio…
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-0.5">
                <p className="flex items-center gap-2 font-medium text-foreground">
                  <span className="relative flex size-2.5">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60 motion-reduce:animate-none" />
                    <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
                  </span>
                  Recording
                  <span
                    className={cn(
                      "font-mono text-sm tabular-nums",
                      nearCap ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                    )}
                  >
                    {formatElapsed(elapsed)}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {recorder.surface ? SURFACE_LABEL[recorder.surface] : "Listening"}
                  {" · "}Keep this tab open — you can switch to your call.
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={!sessionId || busyAction !== null}
                  onClick={() => sessionId && void discard(sessionId)}
                >
                  Discard
                </Button>
                <Button onClick={() => recorder.stop()} className="gap-2">
                  <Square className="size-3.5 fill-current" /> Stop &amp; summarize
                </Button>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <Meter label="Call audio" icon={<AudioLines className="size-4" />} level={recorder.callLevel} />
              <Meter
                label={recorder.micActive ? "Your microphone" : "Microphone off"}
                icon={<Mic className="size-4" />}
                level={recorder.micLevel}
                muted={!recorder.micActive}
              />
            </div>

            {micLost && includeMic && (
              <p className="text-xs text-muted-foreground">
                Your microphone isn&apos;t available, so only the other side of the call is being
                transcribed.
              </p>
            )}
            {heardNothing && (
              <p className="rounded-xl border border-amber-200/80 bg-amber-50/70 px-3 py-2 text-xs text-foreground dark:border-amber-900/50 dark:bg-amber-950/30">
                Orbit hasn&apos;t heard anything yet. If the call is in progress, the shared tab or screen
                may not be the one playing it — stop and share the right one.
              </p>
            )}
          </>
        )}

        {fatal && <FatalNotice message={fatal} />}

        {ordered.length > 0 ? (
          <TranscriptList segments={ordered} onRetry={failedCount ? () => queueRef.current?.retryFailed() : undefined} />
        ) : (
          recorder.state === "recording" && (
            <p className="text-sm text-muted-foreground">
              The transcript appears here about a minute behind the conversation.
            </p>
          )
        )}
      </div>
    );
  }

  // ── Setup ──────────────────────────────────────────────────────────────────────────
  const blocked = !canTranscribe || !hasApiKey;
  return (
    <div className="space-y-4">
      {resumable && (
        <div className="space-y-3 rounded-2xl border border-primary/30 bg-primary/[0.04] p-4">
          <div>
            <p className="font-medium text-foreground">
              Unfinished meeting{resumable.title ? `: “${resumable.title}”` : ""}
            </p>
            <p className="text-sm text-muted-foreground">
              {formatMeetingDuration(resumable.durationMs)} recorded ·{" "}
              {new Date(resumable.startedAtIso).toLocaleString(undefined, {
                weekday: "short",
                hour: "numeric",
                minute: "2-digit",
              })}
              {resumePoint && resumePoint.unsent > 0
                ? ` · ${resumePoint.unsent} part${resumePoint.unsent === 1 ? "" : "s"} still to upload`
                : ""}
            </p>
            {resumable.status === "recording" && (
              <p className="mt-1 text-xs text-muted-foreground">
                If it&apos;s still recording in another tab, stop it there instead.
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busyAction !== null || blocked}
              onClick={() => void adoptForAnalysis(resumable)}
            >
              {busyAction === "analyze" ? <Loader2 className="size-4 animate-spin" /> : null}
              Summarize it now
            </Button>
            <Button
              variant="outline"
              disabled={busyAction !== null || blocked || !resumePoint || !captureSupported}
              onClick={() => startRecording("resume")}
            >
              Continue recording
            </Button>
            <Button
              variant="ghost"
              className="text-muted-foreground"
              disabled={busyAction !== null}
              onClick={() => void discard(resumable.id)}
            >
              Discard
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-5 rounded-2xl border border-border/70 bg-card p-6">
        {!captureSupported && (
          <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-3 text-sm">
            <p className="font-medium text-foreground">{ERROR_COPY.unsupported.title}</p>
            <p className="mt-1 text-muted-foreground">
              {ERROR_COPY.unsupported.detail} Browsers only share a call&apos;s audio from a desktop.
            </p>
          </div>
        )}
        {blocked && (
          <div className="rounded-xl border border-amber-200/80 bg-amber-50/70 px-3 py-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
            <p className="font-medium text-foreground">
              {!canTranscribe ? "Add a key that can transcribe audio" : "Add an AI key to summarize meetings"}
            </p>
            <p className="mt-1 text-muted-foreground">
              {!canTranscribe
                ? "Meeting capture transcribes with OpenAI, Gemini or Wispr — Anthropic can't hear audio. "
                : "Orbit needs your Gemini, OpenAI or Anthropic key to summarize. "}
              Add one in{" "}
              <Link href="/settings" className="font-medium text-primary underline-offset-2 hover:underline">
                Settings
              </Link>
              .
            </p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="meeting-title">Meeting (optional)</Label>
            <Input
              id="meeting-title"
              placeholder="Weekly sync with Acme"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meeting-attendees">Who&apos;s on the call (optional)</Label>
            <Input
              id="meeting-attendees"
              placeholder="Priya Raman, Marcus Lee"
              value={attendeesText}
              onChange={(e) => setAttendeesText(e.target.value)}
            />
          </div>
        </div>
        <p className="-mt-2 text-xs text-muted-foreground">
          Names you list here are spelled the way you typed them, and each becomes a person to review.
        </p>

        <label className="flex items-start gap-2.5 text-sm">
          <Checkbox className="mt-0.5" checked={includeMic} onCheckedChange={(v) => setIncludeMic(Boolean(v))} />
          <span>
            <span className="font-medium text-foreground">Include my microphone</span>
            <span className="block text-xs text-muted-foreground">
              The call&apos;s audio is only the other people — your own voice comes from the mic. Use
              headphones so the call isn&apos;t picked up twice.
            </span>
          </span>
        </label>

        <div className="grid gap-3 rounded-xl bg-muted/40 p-4 text-sm sm:grid-cols-2">
          <div className="space-y-1">
            <p className="flex items-center gap-1.5 font-medium text-foreground">
              <MonitorUp className="size-4 text-muted-foreground" /> Google Meet in a tab
            </p>
            <p className="text-muted-foreground">
              Choose the <strong>Chrome tab</strong> with your call and turn on{" "}
              <strong>Also share tab audio</strong>.
            </p>
          </div>
          <div className="space-y-1">
            <p className="flex items-center gap-1.5 font-medium text-foreground">
              <Headphones className="size-4 text-muted-foreground" /> Zoom or Teams app
            </p>
            <p className="text-muted-foreground">
              Choose <strong>Entire screen</strong> and turn on <strong>Also share system audio</strong>.
              On a Mac this needs Chrome 141+ and macOS 14.2+.
            </p>
          </div>
        </div>

        {recorder.state === "error" && recorder.error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.04] p-3"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">{ERROR_COPY[recorder.error].title}</p>
              <p className="text-xs text-muted-foreground">{ERROR_COPY[recorder.error].detail}</p>
            </div>
          </div>
        )}
        {fatal && <FatalNotice message={fatal} />}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button
            size="lg"
            className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
            disabled={blocked || busyAction !== null || !captureSupported}
            onClick={() => startRecording("new")}
          >
            <AudioLines className="size-4" /> Start listening
          </Button>
          <p className="text-xs text-muted-foreground">
            Let everyone on the call know you&apos;re taking notes — some places require everyone&apos;s
            consent. Orbit keeps the transcript, never the audio. Transcription runs on your own key
            (about $0.36 an hour with OpenAI).
          </p>
        </div>
      </div>
    </div>
  );
}

function Meter({
  label,
  icon,
  level,
  muted = false,
}: {
  label: string;
  icon: React.ReactNode;
  level: MotionValue<number>;
  muted?: boolean;
}) {
  const scaleX = useTransform(level, [0, 1], [0.02, 1]);
  return (
    <div className={cn("flex items-center gap-2 rounded-xl border border-border/60 px-3 py-2", muted && "opacity-50")}>
      <span className="text-muted-foreground">{icon}</span>
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <motion.div className="h-full origin-left rounded-full bg-primary" style={{ scaleX }} />
      </div>
    </div>
  );
}

function FatalNotice({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.04] p-3">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      <p className="text-sm text-foreground">{message}</p>
    </div>
  );
}

const STATUS_COPY: Record<ChunkUploadStatus, string> = {
  queued: "Waiting to upload…",
  uploading: "Transcribing…",
  retrying: "Retrying…",
  done: "",
  failed: "Couldn't upload this part",
};

function TranscriptList({
  segments,
  compact = false,
  onRetry,
}: {
  segments: SegmentView[];
  compact?: boolean;
  onRetry?: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const last = segments[segments.length - 1];
  // Follow the newest line, the way a live caption would — but only nudge the list's own
  // scroll, never the page, so reading back through it is not yanked away.
  useEffect(() => {
    const el = endRef.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last?.seq, last?.text]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-ink">Transcript</p>
        {onRetry && (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Retry failed parts
          </Button>
        )}
      </div>
      <div
        className={cn(
          "space-y-3 overflow-y-auto rounded-xl border border-border/60 bg-muted/20 p-3 text-sm",
          compact ? "max-h-48" : "max-h-96"
        )}
        aria-live="polite"
      >
        {segments.map((s) => (
          <p key={s.seq} className="leading-relaxed">
            <span className="mr-2 font-mono text-xs tabular-nums text-muted-foreground">
              {formatElapsed(s.startMs)}
            </span>
            {s.status === "done" ? (
              s.text ? (
                s.text
              ) : (
                <span className="text-muted-foreground italic">(silence)</span>
              )
            ) : s.silent && s.status !== "failed" ? (
              <span className="text-muted-foreground italic">(silence)</span>
            ) : (
              <span className={cn("italic", s.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                {STATUS_COPY[s.status]}
                {s.detail && s.status !== "uploading" ? ` — ${s.detail}` : ""}
              </span>
            )}
          </p>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function parseAttendees(text: string): { name: string }[] {
  return text
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((name) => ({ name }));
}

function toSelectable(analysis: MeetingAnalysis): SelectableMeetingItem[] {
  const { digest } = analysis;
  return [
    ...digest.actionItems.map((a, i) => ({
      key: `action:${i}`,
      kind: "action" as const,
      text: a.text,
      owner: a.owner,
      sourceExcerpt: a.sourceExcerpt,
      // Your own commitments are the ones you most want reminding of. Other people's are
      // theirs to track; they start unticked but one click away.
      checked: a.owner === "me",
      title: a.text,
    })),
    ...digest.blockers.map((b, i) => ({
      key: `blocker:${i}`,
      kind: "blocker" as const,
      text: b.text,
      owner: b.owner,
      sourceExcerpt: b.sourceExcerpt,
      checked: false,
      title: b.text,
    })),
    ...digest.openQuestions.map((q, i) => ({
      key: `question:${i}`,
      kind: "question" as const,
      text: q.text,
      owner: q.askedBy,
      sourceExcerpt: q.sourceExcerpt,
      checked: false,
      title: q.text,
    })),
  ];
}
