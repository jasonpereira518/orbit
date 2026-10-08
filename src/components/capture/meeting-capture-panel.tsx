"use client";

/**
 * Meeting capture: keep recording a Zoom or Google Meet call while you work anywhere in
 * Orbit, and when you say the meeting is over, Orbit has the transcript, a summary, and the
 * people, reminders, action items, blockers and open questions — landing in the same
 * review-and-save flow as every other capture.
 *
 * This is only a VIEW. The recorder, the live socket, the upload queue and the transcript
 * live in `MeetingSessionProvider` (`meeting-session.tsx`), above the page, so they survive
 * leaving /capture; the bottom-right `MeetingWidget` shows the same state on every other
 * page. See that file for the phases and for why nothing extracts until Finish is confirmed.
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { motion, useTransform, type MotionValue } from "motion/react";
import { AudioLines, Headphones, Loader2, Mic, MicOff, MonitorUp, Pause, Play, TriangleAlert } from "lucide-react";
import type { ResumableMeeting } from "@/lib/meeting-sessions";
import { formatMeetingDuration } from "@/lib/format-meeting-duration";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatElapsed } from "@/lib/voice-recording";
import { MAX_MEETING_MS } from "@/lib/meeting-chunking";
import { MeetingUploadQueue, type ChunkUploadStatus } from "@/lib/meeting-upload-queue";
import type { MeetingRecorderErrorCode, MeetingSurface } from "@/lib/use-meeting-recorder";
import {
  useMeetingFlow,
  useMeetingSession,
  type MeetingFlow,
  type MeetingSession,
  type SegmentView,
} from "@/components/capture/meeting-session";
import { MeetingCalendarSuggestions } from "@/components/capture/meeting-calendar-suggestions";
import { MeetingSaveStatus } from "@/components/capture/meeting-save-status";
import { SideNotes } from "@/components/capture/meeting-side-notes";
import { cn } from "@/lib/utils";
import { AiKeyNotice } from "@/components/ai-key-notice";
import type { AiAccessDenial } from "@/lib/managed-ai-policy";

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

const SURFACE_LABEL: Record<Exclude<MeetingSurface, null>, string> = {
  browser: "Listening to a browser tab",
  window: "Listening to a window",
  monitor: "Listening to your computer",
  mic: "Listening through your microphone",
};

type PanelProps = {
  resumable: ResumableMeeting | null;
  /** AI will run for the analysis — the user's own key, or Orbit's on Lifetime. */
  hasApiKey: boolean;
  /** The AI gate's reason when `hasApiKey` is false — which notice to show. */
  aiReason?: AiAccessDenial | null;
  /** An OpenAI or Gemini key, for transcription. Anthropic cannot transcribe. */
  canTranscribe: boolean;
  /**
   * Desktop Chromium. Without it a meeting can still be summarized — the banner works
   * anywhere — but not recorded.
   */
  captureSupported: boolean;
  /**
   * Any secure browser with a microphone — phones and Safari included. When call audio
   * can't be shared, the meeting is recorded through the mic instead (on speaker, or in
   * the room).
   */
  micSupported?: boolean;
};

export function MeetingCapturePanel(props: PanelProps) {
  const session = useMeetingSession();
  const flow = useMeetingFlow();
  if (!session || !flow) return null;
  return <PanelBody {...props} session={session} flow={flow} />;
}

function PanelBody({
  session: s,
  flow,
  resumable: resumableProp,
  hasApiKey,
  aiReason = null,
  canTranscribe,
  captureSupported,
  micSupported = false,
}: PanelProps & { session: MeetingSession; flow: MeetingFlow }) {
  const { recorder } = s;

  // While this is on screen the widget would only repeat it.
  const { registerInlineView } = flow;
  useEffect(() => registerInlineView(), [registerInlineView]);

  const [resumable, setResumable] = useState<ResumableMeeting | null>(resumableProp);
  // A fresh server answer (after `router.refresh()`) replaces the local one. Adjusted
  // during render, React's pattern for state derived from a changing prop.
  const [resumableSource, setResumableSource] = useState(resumableProp);
  if (resumableSource !== resumableProp) {
    setResumableSource(resumableProp);
    setResumable(resumableProp);
  }
  const [outboxPeek, setOutboxPeek] = useState<{ id: string; count: number; maxSeq: number; maxEndMs: number } | null>(null);

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

  const blocked = !canTranscribe || !hasApiKey;
  const canRecord = captureSupported || micSupported;
  const source = captureSupported ? "display" : "mic";

  const errorNotice =
    recorder.state === "error" && recorder.error ? (
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
    ) : null;

  // ── Finishing / analyzing ──────────────────────────────────────────────────────────
  if (s.phase === "finishing" || s.phase === "analyzing" || s.phase === "pausing") {
    return (
      <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
        {s.analysisError ? (
          <div role="alert" className="space-y-3">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <TriangleAlert className="size-4 text-destructive" /> Couldn&apos;t summarize the meeting
            </p>
            <p className="text-sm text-muted-foreground">{s.analysisError}</p>
            <p className="text-sm text-muted-foreground">The transcript is saved — nothing is lost.</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => s.summarize(true)}>Try again</Button>
              <Button
                variant="ghost"
                onClick={() => s.sessionId && void s.discard(s.sessionId).then((ok) => ok && setResumable(null))}
              >
                Discard meeting
              </Button>
            </div>
          </div>
        ) : s.drainStuck ? (
          <div role="alert" className="space-y-3">
            <p className="font-medium text-foreground">
              {s.drainStuck.backlog} part{s.drainStuck.backlog === 1 ? "" : "s"} of the meeting haven&apos;t uploaded yet
            </p>
            <p className="text-sm text-muted-foreground">
              They are saved in this browser and will keep trying. You can wait, or summarize what has
              arrived so far.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={s.retryUpload}>
                Retry upload
              </Button>
              <Button onClick={() => s.summarize()}>Summarize anyway</Button>
            </div>
          </div>
        ) : (
          <div aria-live="polite" className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin text-primary" />
            {s.phase === "pausing"
              ? "Saving where you left off…"
              : s.phase === "finishing"
                ? s.pendingCount > 0
                  ? `Finishing the transcript — ${s.pendingCount} part${s.pendingCount === 1 ? "" : "s"} left…`
                  : "Finishing the transcript…"
                : "Summarizing the meeting and pulling out people, next steps, blockers and questions…"}
          </div>
        )}
        {s.segments.length > 0 && <TranscriptList segments={s.segments} compact />}
      </div>
    );
  }

  // ── Asking for the share (a new meeting, or a resume) ─────────────────────────────
  if (recorder.state === "requesting") {
    return (
      <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
        <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <Loader2 className="size-4 animate-spin" /> Pick your call&apos;s tab or screen, and turn on its audio…
        </p>
      </div>
    );
  }

  // ── Live ───────────────────────────────────────────────────────────────────────────
  if (s.phase === "live") {
    const nearCap = MAX_MEETING_MS - s.totalMs < 5 * 60_000;
    return (
      <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
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
                  nearCap ? "text-amber-600 dark:text-warning" : "text-muted-foreground"
                )}
              >
                {formatElapsed(s.totalMs)}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              {recorder.surface ? SURFACE_LABEL[recorder.surface] : "Listening"}
              {" · "}
              {recorder.surface === "mic"
                ? "Keep Orbit in front — some browsers stop the microphone in the background."
                : "Switch to your call, or to any other page — it keeps recording."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={!s.sessionId || s.busyAction !== null}
              onClick={() => s.sessionId && void s.discard(s.sessionId).then((ok) => ok && setResumable(null))}
            >
              Discard
            </Button>
            <Button variant="outline" onClick={() => s.pause()} className="gap-2">
              <Pause className="size-3.5 fill-current" /> Pause
            </Button>
            <FinishButton onConfirm={s.finish} />
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Meter label="Call audio" icon={<AudioLines className="size-4" />} level={recorder.callLevel} />
          <div className="flex items-stretch gap-2">
            <div className="min-w-0 flex-1">
              <Meter
                label={!recorder.micActive ? "Microphone off" : recorder.micMuted ? "Microphone muted" : "Your microphone"}
                icon={recorder.micMuted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                level={recorder.micLevel}
                muted={!recorder.micActive || recorder.micMuted}
              />
            </div>
            {recorder.micActive && recorder.surface !== "mic" && (
              <Button
                type="button"
                variant={recorder.micMuted ? "default" : "outline"}
                size="icon"
                className="h-auto shrink-0"
                aria-pressed={recorder.micMuted}
                aria-label={recorder.micMuted ? "Unmute microphone" : "Mute microphone"}
                title={recorder.micMuted ? "Unmute microphone" : "Mute microphone"}
                onClick={() => recorder.setMicMuted(!recorder.micMuted)}
              >
                {recorder.micMuted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </Button>
            )}
          </div>
        </div>
        {recorder.micMuted && (
          <p className="text-xs text-muted-foreground" role="status">
            Your microphone is muted — the call is still being recorded, but nothing you say is.
          </p>
        )}

        {s.micLost && s.includeMic && (
          <p className="text-xs text-muted-foreground">
            Your microphone isn&apos;t available, so only the other side of the call is being
            transcribed.
          </p>
        )}
        {s.quotaWarnMinutes !== null && (
          <p className="rounded-xl border border-warning-border bg-warning-surface px-3 py-2 text-xs text-foreground">
            About {s.quotaWarnMinutes} minute{s.quotaWarnMinutes === 1 ? "" : "s"} of meeting
            transcription left this month — it comes back on {s.quotaResetLabel}.
          </p>
        )}
        {s.liveStatus === "reconnecting" && (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            Live transcription dropped out — reconnecting. Nothing is being lost: this stretch is
            uploading the slower way.
          </p>
        )}
        {s.heardNothing && (
          <p className="rounded-xl border border-warning-border bg-warning-surface px-3 py-2 text-xs text-foreground">
            Orbit hasn&apos;t heard anything yet. If the call is in progress, the shared tab or screen
            may not be the one playing it.{" "}
            <button
              type="button"
              onClick={() => s.pause({ release: true })}
              className="font-medium underline underline-offset-2"
            >
              Choose a different tab
            </button>
          </p>
        )}
        {recorder.callQuiet && !s.heardNothing && (
          <p
            role="status"
            className="rounded-xl border border-warning-border bg-warning-surface px-3 py-2 text-xs text-foreground"
          >
            No call audio for a minute. Is the right tab shared?{" "}
            <button
              type="button"
              onClick={() => s.pause({ release: true })}
              className="font-medium underline underline-offset-2"
            >
              Choose a different tab
            </button>
          </p>
        )}

        <SideNotes value={s.sideNotes} onChange={s.setSideNotes} />

        {s.fatal && <FatalNotice message={s.fatal} />}

        {s.segments.length > 0 || s.liveInterim ? (
          <TranscriptList
            segments={s.segments}
            interim={s.liveInterim}
            boundaries={s.reconnectSeqs}
            onRetry={s.failedCount ? s.retryFailedParts : undefined}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {s.liveStatus === "live" || s.liveStatus === "connecting"
              ? "The transcript appears here a second or two behind the conversation."
              : "The transcript appears here about a minute behind the conversation."}
          </p>
        )}
      </div>
    );
  }

  // ── Paused ─────────────────────────────────────────────────────────────────────────
  if (s.phase === "paused") {
    return (
      <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <span className="size-2.5 rounded-full bg-amber-500" />
              Paused
              <span className="font-mono text-sm tabular-nums text-muted-foreground">{formatElapsed(s.totalMs)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {s.shareKept
                ? "Nothing is being recorded, but Chrome still shows you're sharing and your mic is on. Resume picks up right where you left off."
                : "Nothing is being recorded. Resume asks you to pick the tab again and carries on in the same transcript."}{" "}
              Orbit won&apos;t summarize the meeting until you finish it.
            </p>
            <MeetingSaveStatus pending={s.pendingCount} failed={s.failedCount} onRetry={s.retryFailedParts} className="pt-0.5" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={!s.sessionId || s.busyAction !== null}
              onClick={() => s.sessionId && void s.discard(s.sessionId).then((ok) => ok && setResumable(null))}
            >
              Discard
            </Button>
            {s.shareKept && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                disabled={s.busyAction !== null}
                onClick={() => s.pause({ release: true })}
              >
                Stop sharing
              </Button>
            )}
            <Button
              variant="outline"
              className="gap-2"
              disabled={blocked || !s.ready || s.atCap || !canRecord || s.busyAction !== null}
              onClick={s.resume}
            >
              <Play className="size-3.5 fill-current" /> Resume recording
            </Button>
            <FinishButton onConfirm={s.finish} disabled={s.busyAction !== null} />
          </div>
        </div>
        {s.atCap && (
          <p className="text-xs text-muted-foreground">
            This meeting reached {formatMeetingDuration(MAX_MEETING_MS)}, the longest Orbit records. Finish it
            to summarize.
          </p>
        )}
        {errorNotice}
        {s.fatal && <FatalNotice message={s.fatal} />}
        <SideNotes value={s.sideNotes} onChange={s.setSideNotes} />
        {s.segments.length > 0 && (
          <TranscriptList
            segments={s.segments}
            boundaries={s.reconnectSeqs}
            onRetry={s.failedCount ? s.retryFailedParts : undefined}
          />
        )}
      </div>
    );
  }

  // ── Setup ──────────────────────────────────────────────────────────────────────────
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
              disabled={s.busyAction !== null || blocked}
              onClick={() => void s.adoptForAnalysis(resumable)}
            >
              {s.busyAction === "analyze" ? <Loader2 className="size-4 animate-spin" /> : null}
              Summarize it now
            </Button>
            <Button
              variant="outline"
              disabled={s.busyAction !== null || blocked || !s.ready || !resumePoint || !canRecord}
              onClick={() =>
                resumePoint &&
                s.startRecording(
                  { id: resumable.id, startSeq: resumePoint.startSeq, offsetMs: resumePoint.offsetMs, reload: true },
                  source
                )
              }
            >
              Continue recording
            </Button>
            <Button
              variant="ghost"
              className="text-muted-foreground"
              disabled={s.busyAction !== null}
              onClick={() => void s.discard(resumable.id).then((ok) => ok && setResumable(null))}
            >
              Discard
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-5 rounded-2xl border border-border/70 bg-card p-6">
        {!captureSupported && micSupported && (
          <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-3 text-sm">
            <p className="font-medium text-foreground">This browser can&apos;t hear the call itself</p>
            <p className="mt-1 text-muted-foreground">
              Safari and phones can&apos;t share a call&apos;s audio, so Orbit will listen through your
              microphone instead. Put the call on speaker, keep this page open and in front, and let
              everyone know you&apos;re taking notes.
            </p>
          </div>
        )}
        {!captureSupported && !micSupported && (
          <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-3 text-sm">
            <p className="font-medium text-foreground">{ERROR_COPY.unsupported.title}</p>
            <p className="mt-1 text-muted-foreground">
              {ERROR_COPY.unsupported.detail} Browsers only share a call&apos;s audio from a desktop.
            </p>
          </div>
        )}
        {blocked &&
          (!hasApiKey ? (
            // The gate's verdict first: no key, allowance spent, payment still clearing.
            <AiKeyNotice feature="meeting" reason={aiReason} />
          ) : (
            <div className="rounded-xl border border-warning-border bg-warning-surface px-3 py-3 text-sm">
              <p className="font-medium text-foreground">Add a key that can transcribe audio</p>
              <p className="mt-1 text-muted-foreground">
                Meeting capture transcribes with OpenAI or Gemini — Anthropic can&apos;t hear
                audio. Add one in{" "}
                <Link href="/settings" className="font-medium text-primary underline-offset-2 hover:underline">
                  Settings
                </Link>
                .
              </p>
            </div>
          ))}

        <p className="-mb-2 text-right text-xs">
          <Link href="/meetings" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            Past meetings →
          </Link>
        </p>
        {canRecord && <MeetingCalendarSuggestions onUse={s.applyCalendarMeeting} />}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="meeting-title">Meeting (optional)</Label>
            <Input
              id="meeting-title"
              placeholder="Weekly sync with Acme"
              value={s.title}
              maxLength={200}
              onChange={(e) => s.setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meeting-attendees">Who&apos;s on the call (optional)</Label>
            <Input
              id="meeting-attendees"
              placeholder="Priya Raman, Marcus Lee"
              value={s.attendeesText}
              onChange={(e) => s.setAttendeesText(e.target.value)}
            />
          </div>
        </div>
        <p className="-mt-2 text-xs text-muted-foreground">
          Names you list here are spelled the way you typed them, and each becomes a person to review.
        </p>

        {captureSupported && (
        <label className="flex items-start gap-2.5 text-sm">
          <Checkbox className="mt-0.5" checked={s.includeMic} onCheckedChange={(v) => s.setIncludeMic(Boolean(v))} />
          <span>
            <span className="font-medium text-foreground">Include my microphone</span>
            <span className="block text-xs text-muted-foreground">
              The call&apos;s audio is only the other people — your own voice comes from the mic. Use
              headphones so the call isn&apos;t picked up twice.
            </span>
          </span>
        </label>
        )}

        {captureSupported && (
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
        )}

        {errorNotice}
        {s.fatal && <FatalNotice message={s.fatal} />}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {captureSupported ? (
            <Button
              size="lg"
              className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={blocked || !s.ready || s.busyAction !== null}
              onClick={() => s.startRecording(null, "display")}
            >
              <AudioLines className="size-4" /> Start listening
            </Button>
          ) : (
            <Button
              size="lg"
              className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={blocked || !s.ready || s.busyAction !== null || !micSupported}
              onClick={() => s.startRecording(null, "mic")}
            >
              <Mic className="size-4" /> Record with my microphone
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            Let everyone on the call know you&apos;re taking notes — some places require everyone&apos;s
            consent. Orbit keeps the transcript, never the audio. Transcription runs on Orbit&apos;s
            own key, within your plan&apos;s monthly meeting hours.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Finishing is the one irreversible step — it is what makes Orbit summarize the meeting and
 * pull people and follow-ups out of it — so it asks first, in place, rather than on a click.
 */
function FinishButton({ onConfirm, disabled = false }: { onConfirm: () => void; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button disabled={disabled} onClick={() => setAsking(true)}>
        Finish meeting
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm finishing the meeting">
      <span className="text-sm text-foreground">Is the meeting over?</span>
      <Button
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        Yes, summarize it
      </Button>
      <Button variant="ghost" onClick={() => setAsking(false)}>
        Not yet
      </Button>
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

/** "you" / "speaker-2" from the speaker map, as a person would read it. */
function speakerLabel(speaker: string): string {
  if (speaker === "you") return "You";
  const n = /^speaker-(\d+)$/.exec(speaker)?.[1];
  return n ? `Speaker ${n}` : speaker;
}

function TranscriptList({
  segments,
  compact = false,
  interim = "",
  boundaries,
  onRetry,
}: {
  segments: SegmentView[];
  compact?: boolean;
  /** The sentence being spoken right now, greyed until Deepgram settles on it. */
  interim?: string;
  /** Seqs where a new live connection began — Deepgram renumbers speakers across one. */
  boundaries?: number[];
  onRetry?: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const last = segments[segments.length - 1];
  const boundarySet = useMemo(() => new Set(boundaries ?? []), [boundaries]);
  // Follow the newest line, the way a live caption would — but only nudge the list's own
  // scroll, never the page, so reading back through it is not yanked away.
  useEffect(() => {
    const el = endRef.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last?.seq, last?.text, interim]);

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
        <SegmentLines segments={segments} boundarySet={boundarySet} />
        {/*
          `aria-hidden`, inside an `aria-live` region on purpose. Deepgram revises the
          in-progress sentence several times a second, and every revision would otherwise be
          re-announced from the top — the same aria-live pile-up this repo has been bitten
          by before. The sentence is announced once, when it lands as a real segment above.
        */}
        {interim && (
          <p aria-hidden className="leading-relaxed text-muted-foreground/70">
            {interim}
          </p>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

/**
 * The settled lines, apart from the live one. Memoized so the interim sentence — revised
 * several times a second — and the elapsed tick re-render one line, not every segment of a
 * meeting that can run for three hours.
 */
const SegmentLines = memo(function SegmentLines({
  segments,
  boundarySet,
}: {
  segments: SegmentView[];
  boundarySet: Set<number>;
}) {
  return (
    <>
      {segments.map((s) => (
        <div key={s.seq}>
          {boundarySet.has(s.seq) && (
            <p className="my-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
              Reconnected — speakers renumbered from here.
            </p>
          )}
          <p className="leading-relaxed">
            <span className="mr-2 font-mono text-xs tabular-nums text-muted-foreground">
              {formatElapsed(s.startMs)}
            </span>
            {s.speaker && (
              <span className="mr-1.5 font-medium text-foreground">{speakerLabel(s.speaker)}:</span>
            )}
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
        </div>
      ))}
    </>
  );
});
