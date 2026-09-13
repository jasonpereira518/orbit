"use client";

/**
 * The record surface for voice notes.
 *
 * Sized for the moment it exists for: you are walking out of a building holding a phone in
 * one hand. So one very large target, one decision ("am I recording or not"), and
 * everything else subordinate. The same component serves desktop — a big button is not
 * wrong there, just generous.
 *
 * Owns `useVoiceRecorder` and nothing else. It hands the finished WAV up and takes no view
 * on what happens to it, which is what lets `BulkNotesPanel` route it through the same
 * ingest path a hand-picked audio file already takes.
 */

import { AnimatePresence, motion, useTransform } from "motion/react";
import { Loader2, Mic, Square, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { useDelayedLoading } from "@/lib/use-delayed-loading";
import { cn } from "@/lib/utils";
import {
  MAX_RECORDING_MS,
  formatElapsed,
} from "@/lib/voice-recording";
import {
  useVoiceRecorder,
  type VoiceRecorderErrorCode,
  type VoiceRecording,
} from "@/lib/use-voice-recorder";

/** How long before the cap the clock starts warning. */
const WARN_REMAINING_MS = 30_000;

/**
 * Copy per failure.
 *
 * Each one says what happened and what to do next. "not-allowed" deliberately does not say
 * "try again" — Chrome will not re-prompt after a denial, so the only real path is the
 * address-bar control, and a retry button that silently does nothing is worse than a
 * sentence that tells the truth.
 */
const ERROR_COPY: Record<VoiceRecorderErrorCode, { title: string; detail: string }> = {
  "not-allowed": {
    title: "Orbit can't hear your microphone",
    detail:
      "Microphone access was blocked. Allow it for this site in your browser's address bar, then start again.",
  },
  "no-microphone": {
    title: "No microphone found",
    detail:
      "Your browser couldn't open a recording device. Check that one is connected and not in use by another app.",
  },
  "insecure-context": {
    title: "Recording needs a secure connection",
    detail: "Browsers only allow microphone access over HTTPS or on localhost.",
  },
  "too-short": {
    title: "That was too quick to hear",
    detail: "Hold the button long enough to say a sentence, then stop.",
  },
  unknown: {
    title: "Recording didn't start",
    detail: "Something went wrong reaching your microphone. Try once more.",
  },
};

export function VoiceRecorder({
  onRecording,
  busy = false,
  busyLabel,
  onCapReached,
  size = "default",
  idleHint,
}: {
  /** A finished WAV, ready to hand to capture's ingest path. */
  onRecording: (recording: VoiceRecording) => void;
  /** The parent is transcribing or extracting; block a second recording until it lands. */
  busy?: boolean;
  /** What the parent is doing, shown under the button while `busy`. */
  busyLabel?: string;
  onCapReached?: () => void;
  /** `hero` is the Voice tab's centrepiece; `default` is the size the old panel used. */
  size?: "default" | "hero";
  /** Replaces the idle sentence under the button. */
  idleHint?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const recorder = useVoiceRecorder({ onRecording, onCapReached });
  const { state, error, level, elapsedMs } = recorder;

  // An already-granted mic resolves in ~20ms; without the delay that is a spinner flash.
  const showSpinner = useDelayedLoading(state === "requesting", 150);

  const ringScale = useTransform(level, [0, 1], size === "hero" ? [1.04, 1.6] : [1.04, 1.45]);
  const ringOpacity = useTransform(level, [0, 1], [0.12, 0.4]);

  const recording = state === "recording";
  const remainingMs = Math.max(0, MAX_RECORDING_MS - elapsedMs);
  const nearCap = recording && remainingMs <= WARN_REMAINING_MS;

  if (state === "unsupported") {
    return (
      <p className="rounded-xl border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground">
        This browser can&apos;t record audio. You can still type or paste your notes below.
      </p>
    );
  }

  const disabled = busy || state === "encoding";

  return (
    <div className="flex flex-col items-center gap-3 py-2">
      <div className="relative flex items-center justify-center">
        {/* The breathing ring, driven straight off the MotionValue so a 125 Hz meter never
            re-renders the panel around it. */}
        <AnimatePresence initial={false}>
          {recording && !reduced && (
            <motion.span
              aria-hidden
              className="absolute inset-0 rounded-full bg-primary"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: DUR.fast, ease: EASE_HOUSE }}
              style={{ scale: ringScale, opacity: ringOpacity }}
            />
          )}
        </AnimatePresence>

        <Button
          type="button"
          size="icon"
          variant={recording ? "default" : "outline"}
          disabled={disabled}
          aria-busy={state === "requesting" || state === "encoding" || undefined}
          aria-pressed={recording}
          aria-label={recording ? "Stop recording" : "Start recording"}
          onClick={() => {
            if (state === "error") recorder.reset();
            if (recording) recorder.stop();
            else recorder.start();
          }}
          className={cn(
            "relative shrink-0 overflow-visible rounded-full shadow-sm transition-colors",
            size === "hero" ? "size-32 sm:size-28" : "size-24 sm:size-20",
            recording &&
              "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
            state === "error" && "border-destructive/50 text-destructive",
          )}
        >
          {showSpinner || state === "encoding" ? (
            <Loader2 className={cn("animate-spin", size === "hero" ? "size-9" : "size-7")} />
          ) : recording ? (
            // A square, not a second mic: the control's job changes when it is on, and the
            // glyph should say so without reading the label.
            <Square className={cn("fill-current", size === "hero" ? "size-9" : "size-7")} />
          ) : (
            <Mic className={size === "hero" ? "size-11" : "size-8"} />
          )}
        </Button>
      </div>

      {/* One live region for the whole control. The button's aria-label covers the toggle;
          this carries the running state a sighted user reads off the clock. */}
      <p
        aria-live="polite"
        className={cn(
          "min-h-5 text-center text-sm tabular-nums",
          nearCap ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
        )}
      >
        {state === "requesting" && "Waiting for microphone…"}
        {state === "encoding" && "Finishing up…"}
        {recording &&
          (nearCap
            ? `${formatElapsed(elapsedMs)} — stopping in ${Math.ceil(remainingMs / 1000)}s`
            : formatElapsed(elapsedMs))}
        {state === "idle" &&
          !busy &&
          (idleHint ?? "Talk through who you met and what you agreed — Orbit sorts it out.")}
        {busy && (busyLabel ?? "Working…")}
      </p>

      {recording && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => recorder.cancel()}
        >
          Discard
        </Button>
      )}

      {state === "error" && error && (
        <div
          role="alert"
          className="flex w-full items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.04] p-3 text-left"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-foreground">{ERROR_COPY[error].title}</p>
            <p className="text-xs text-muted-foreground">{ERROR_COPY[error].detail}</p>
          </div>
        </div>
      )}
    </div>
  );
}
