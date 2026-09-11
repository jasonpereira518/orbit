"use client";

/**
 * The record surface for voice notes.
 *
 * Sized for the moment it exists for: you are walking out of a building holding a phone in
 * one hand. So one very large target, one decision ("am I recording or not"), and
 * everything else subordinate. The same component serves desktop — a big button is not
 * wrong there, just generous.
 *
 * The one button takes both grips people reach for. Hold it and talk, and letting go ends
 * the note — a walkie-talkie. Tap it, and it records until the next tap — for the longer
 * debrief nobody wants to hold a thumb down through. Which one you meant is read off how
 * long the first press lasted, so there is no mode to pick.
 *
 * Owns `useVoiceRecorder` and nothing else. It hands the finished WAV up and takes no view
 * on what happens to it, which is what lets `BulkNotesPanel` route it through the same
 * ingest path a hand-picked audio file already takes.
 */

import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
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
 * A press shorter than this is a tap: recording keeps going until the next tap. Anything
 * longer was push-to-talk, and letting go ends it. Long enough that a deliberate tap never
 * reads as a hold, short enough that a hold feels like one from the first word.
 */
const TAP_MS = 300;

/** How the current recording ends: on release, or on the next tap. */
type PressMode = "hold" | "toggle";

/**
 * Copy per failure.
 *
 * Each one says what happened and what to do next. "not-allowed" deliberately does not say
 * "try again" — Chrome will not re-prompt after a denial, so the only real path is the
 * address-bar control, and a retry button that silently does nothing is worse than a
 * sentence that tells the truth.
 */
export const VOICE_ERROR_COPY: Record<
  VoiceRecorderErrorCode,
  { title: string; detail: string }
> = {
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
    detail:
      "Hold the mic a little longer, or tap it to start and tap again to stop.",
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
  size = "hero",
}: {
  /** A finished WAV, ready to hand to capture's ingest path. */
  onRecording: (recording: VoiceRecording) => void;
  /** The parent is transcribing or extracting; block a second recording until it lands. */
  busy?: boolean;
  /** What the parent is doing, shown under the button while `busy`. */
  busyLabel?: string;
  onCapReached?: () => void;
  /**
   * `hero` is the whole Voice tab before anything is said. `compact` is the small "add
   * more" control that sits beside a transcript once there is one.
   */
  size?: "hero" | "compact";
}) {
  const reduced = usePrefersReducedMotion();
  const recorder = useVoiceRecorder({ onRecording, onCapReached });
  const { state, error, level, elapsedMs } = recorder;

  /** When the press that started this session went down; null once it has been released. */
  const pressStartedAtRef = useRef<number | null>(null);
  const [pressMode, setPressMode] = useState<PressMode>("hold");

  // An already-granted mic resolves in ~20ms; without the delay that is a spinner flash.
  const showSpinner = useDelayedLoading(state === "requesting", 150);

  const ringScale = useTransform(level, [0, 1], [1.04, 1.45]);
  const ringOpacity = useTransform(level, [0, 1], [0.12, 0.4]);

  const recording = state === "recording";
  const remainingMs = Math.max(0, MAX_RECORDING_MS - elapsedMs);
  const nearCap = recording && remainingMs <= WARN_REMAINING_MS;
  const compact = size === "compact";

  if (state === "unsupported") {
    return (
      <p className="rounded-xl border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground">
        This browser can&apos;t record audio. The Messy Notes tab takes typed or pasted notes.
      </p>
    );
  }

  const disabled = busy || state === "encoding";

  function handlePointerDown(e: ReactPointerEvent<HTMLButtonElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (disabled || state === "requesting") return;
    // The second tap of a tap-to-toggle note. Stopping on the way down rather than up
    // makes the end of the note land where the finger did.
    if (recording) {
      recorder.stop();
      return;
    }
    try {
      // Keeps the release on this button when a thumb drifts off it mid-sentence.
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-released pointer; the release still arrives, just unaimed.
    }
    if (state === "error") recorder.reset();
    pressStartedAtRef.current = Date.now();
    setPressMode("hold");
    // Synchronously, inside the press: see the note on the AudioContext in `start()`.
    recorder.start();
  }

  function handleRelease() {
    recorder.resumeAudio();
    const startedAt = pressStartedAtRef.current;
    pressStartedAtRef.current = null;
    if (startedAt === null) return;
    // A quick tap, or a hold that outlasted the permission prompt and has not started yet:
    // either way there is nothing to stop on release, so the next tap ends it instead.
    if (Date.now() - startedAt < TAP_MS || !recording) {
      setPressMode("toggle");
      return;
    }
    recorder.stop();
  }

  const micButton = (
    <div className="relative flex shrink-0 items-center justify-center">
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
        onPointerDown={handlePointerDown}
        onPointerUp={handleRelease}
        onPointerCancel={handleRelease}
        // A long press is the whole point of this button; the OS menu it would open is not.
        onContextMenu={(e) => e.preventDefault()}
        onClick={(e) => {
          // Pointer presses are fully handled above. A keyboard activation arrives as a
          // click with `detail` 0 and no pointer behind it, and has nothing to hold, so it
          // always toggles.
          if (e.detail !== 0) return;
          if (recording) {
            recorder.stop();
            return;
          }
          if (state === "error") recorder.reset();
          setPressMode("toggle");
          recorder.start();
        }}
        className={cn(
          "relative shrink-0 touch-none overflow-visible rounded-full shadow-sm transition-colors select-none [-webkit-touch-callout:none]",
          compact ? "size-12" : "size-32 sm:size-24",
          recording &&
            "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
          state === "error" && "border-destructive/50 text-destructive",
        )}
      >
        {showSpinner || state === "encoding" ? (
          <Loader2 className={cn("animate-spin", compact ? "size-5" : "size-10 sm:size-8")} />
        ) : recording ? (
          // A square, not a second mic: the control's job changes when it is on, and the
          // glyph should say so without reading the label.
          <Square className={cn("fill-current", compact ? "size-4" : "size-9 sm:size-7")} />
        ) : (
          <Mic className={compact ? "size-5" : "size-12 sm:size-9"} />
        )}
      </Button>
    </div>
  );

  // One live region for the whole control. The button's aria-label covers the toggle;
  // this carries the running state a sighted user reads off the clock.
  const status = (
    <p
      aria-live="polite"
      className={cn(
        "min-h-5 text-sm tabular-nums",
        !compact && "text-center",
        nearCap ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
      )}
    >
      {state === "requesting" && "Waiting for microphone…"}
      {state === "encoding" && "Finishing up…"}
      {recording &&
        (nearCap
          ? `${formatElapsed(elapsedMs)} — stopping in ${Math.ceil(remainingMs / 1000)}s`
          : `${pressMode === "hold" ? "Release to finish" : "Tap to stop"} · ${formatElapsed(elapsedMs)}`)}
      {(state === "idle" || state === "error") &&
        !busy &&
        (compact ? "Hold or tap to add more" : "Hold to talk, or tap to start")}
      {busy && (busyLabel ?? "Working…")}
    </p>
  );

  const discard = recording && (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="text-muted-foreground"
      onClick={() => recorder.cancel()}
    >
      Discard
    </Button>
  );

  const errorAlert = state === "error" && error && (
    <div
      role="alert"
      className="flex w-full items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.04] p-3 text-left"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-foreground">{VOICE_ERROR_COPY[error].title}</p>
        <p className="text-xs text-muted-foreground">{VOICE_ERROR_COPY[error].detail}</p>
      </div>
    </div>
  );

  if (compact) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          {micButton}
          {status}
          {discard}
        </div>
        {errorAlert}
      </div>
    );
  }

  return (
    // On a phone the mic IS the tab: it takes the upper half of the screen, centred, so
    // the thumb finds it without looking. From `sm` up it is a generous button in a card.
    <div className="flex min-h-[45svh] flex-col items-center justify-center gap-4 py-2 sm:min-h-0 sm:gap-3 sm:py-6">
      {micButton}
      {status}
      {discard}
      {errorAlert}
    </div>
  );
}
