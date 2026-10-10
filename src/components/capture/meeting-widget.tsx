"use client";

/**
 * The meeting, from every page that is not /capture.
 *
 * Rendered inside the bottom-right job stack (`GlobalJobProgressBar`), which already owns the
 * corner and publishes its height so toasts sit above it. It is a second view of the state in
 * `meeting-session.tsx` and does exactly two things: Pause/Resume, and a link back to the
 * full panel. Finishing is deliberately NOT here — it summarizes the meeting, and the
 * summary has to be started from /capture (see the header of `meeting-session.tsx`).
 */

import { useState } from "react";
import Link from "next/link";
import { Loader2, Mic, MicOff, Pause, Play, StickyNote } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { MeetingSaveStatus } from "@/components/capture/meeting-save-status";
import { SideNotes } from "@/components/capture/meeting-side-notes";
import { formatElapsed } from "@/lib/format-elapsed";
import { useMeetingFlow, useMeetingSession } from "@/components/capture/meeting-session";
import { cn } from "@/lib/utils";

const MEETING_HREF = "/capture?mode=meeting";

export function MeetingWidget() {
  const s = useMeetingSession();
  const flow = useMeetingFlow();
  const [noting, setNoting] = useState(false);
  if (!s || !flow?.widgetVisible) return null;

  const { phase, recorder } = s;
  const canNote = phase === "live" || phase === "paused";
  const requesting = recorder.state === "requesting";
  const working = phase === "pausing" || phase === "finishing" || phase === "analyzing";
  const ready = phase === "setup" && flow.hasPendingAnalysis;

  const label = ready
    ? "Meeting summary ready"
    : phase === "live"
      ? "Recording"
      : phase === "paused"
        ? "Paused"
        : phase === "pausing"
          ? "Saving where you left off…"
          : phase === "finishing"
            ? "Finishing the transcript…"
            : "Summarizing the meeting…";

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-border/70 bg-card/95 p-3 shadow-lg backdrop-blur-md"
      role="status"
    >
      <div className="flex items-center gap-2.5">
      <span className="shrink-0">
        {working || requesting ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : phase === "live" ? (
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
          </span>
        ) : (
          <span className={cn("block size-2.5 rounded-full", ready ? "bg-primary" : "bg-amber-500")} />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">
          {label}
          {(phase === "live" || phase === "paused") && (
            <span className="ml-2 font-mono text-xs tabular-nums text-muted-foreground">
              {formatElapsed(s.totalMs)}
            </span>
          )}
        </p>
        {phase === "paused" && (
          <>
            {s.shareKept && <p className="truncate text-xs text-muted-foreground">Still sharing — Resume is one click</p>}
            <MeetingSaveStatus pending={s.pendingCount} failed={s.failedCount} onRetry={s.retryFailedParts} />
          </>
        )}
        {s.fatal && <p className="truncate text-xs text-destructive">{s.fatal}</p>}
      </div>

      {phase === "live" && (
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => s.pause()}>
          <Pause className="size-3.5 fill-current" /> Pause
        </Button>
      )}
      {phase === "paused" && !requesting && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={s.atCap || s.busyAction !== null}
          onClick={s.resume}
        >
          <Play className="size-3.5 fill-current" /> Resume
        </Button>
      )}
      {phase === "live" && recorder.micActive && recorder.surface !== "mic" && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("px-2", recorder.micMuted ? "text-amber-600 dark:text-warning" : "text-muted-foreground")}
          aria-pressed={recorder.micMuted}
          aria-label={recorder.micMuted ? "Unmute microphone" : "Mute microphone"}
          title={recorder.micMuted ? "Unmute microphone" : "Mute microphone"}
          onClick={() => recorder.setMicMuted(!recorder.micMuted)}
        >
          {recorder.micMuted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
        </Button>
      )}
      {canNote && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1 px-2 text-muted-foreground"
          aria-label="Add a side note"
          title="Add a side note"
          aria-expanded={noting}
          onClick={() => setNoting((v) => !v)}
        >
          <StickyNote className="size-3.5" />
          {s.sideNotes.trim() && <span className="size-1.5 rounded-full bg-primary" aria-label="Has notes" />}
        </Button>
      )}
      <Link
        href={MEETING_HREF}
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-muted-foreground")}
      >
        {ready ? "Review" : "Open"}
      </Link>
      </div>
      {canNote && noting && <SideNotes compact autoFocus value={s.sideNotes} onChange={s.setSideNotes} />}
    </div>
  );
}
