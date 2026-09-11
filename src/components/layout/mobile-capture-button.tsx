"use client";

/**
 * The raised Capture circle in the phone nav.
 *
 * A tap opens the Voice tab, as it always has. A hold turns the circle into a microphone:
 * talk, let go, and you land on the Voice tab with the note already transcribing. That is
 * the whole capture for the "walking out of the building" moment, done without looking
 * for a button on a page that has not loaded yet.
 *
 * It records here, not on the capture page, because the page does not exist until the
 * finger lifts. `MobileNav` sits above the remounting route template and survives the
 * navigation, so the microphone does too; the finished WAV crosses over through
 * `src/lib/pending-voice-note.ts` and is picked up by the Voice tab's panel.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, motion, useTransform } from "motion/react";
import { Mic, type LucideIcon } from "lucide-react";

import { VOICE_ERROR_COPY } from "@/components/capture/voice-recorder";
import { DUR, EASE_HOUSE, SPRING_TAP } from "@/lib/motion";
import { handOffVoiceRecording } from "@/lib/pending-voice-note";
import { toast } from "@/lib/toast";
import { useVoiceRecorder } from "@/lib/use-voice-recorder";
import { cn } from "@/lib/utils";
import { MAX_RECORDING_MS, formatElapsed } from "@/lib/voice-recording";

/**
 * How long a press must last before it is a hold. Past the ~300ms a tap takes, so an
 * ordinary tap never opens the microphone, and short enough that it reads as a response
 * to the press rather than a wait.
 */
const HOLD_MS = 350;

/** A press that wanders further than this before the hold lands was not a hold. */
const HOLD_SLOP_PX = 10;

/** How far the circle rises while it is a microphone — see where it is used. */
const HOLD_LIFT_PX = -6;

/**
 * Voice, not the paste box. On a phone the capture moment is "walking out of the
 * building", where typing is the one thing you cannot do; the Messy Notes tab is still
 * one tap away on arrival.
 */
const VOICE_CAPTURE_HREF = "/capture?mode=voice";

export function MobileCaptureButton({
  label,
  icon: Icon,
  reducedMotion,
}: {
  label: string;
  icon: LucideIcon;
  reducedMotion: boolean | null;
}) {
  const router = useRouter();
  const recorder = useVoiceRecorder({
    onRecording: (recording) => {
      handOffVoiceRecording(recording);
      router.push(VOICE_CAPTURE_HREF);
    },
    onError: (code) => {
      if (code === "too-short") {
        // Also where a hold lands if the browser never let the audio run (see
        // `resumeAudio`). Either way the page's own mic is the next best thing.
        toast.info("Hold a little longer — or tap the mic here");
        router.push(VOICE_CAPTURE_HREF);
        return;
      }
      toast.error(VOICE_ERROR_COPY[code].title, {
        description: VOICE_ERROR_COPY[code].detail,
      });
    },
    onCapReached: () =>
      toast.info(
        `Stopped at ${formatElapsed(MAX_RECORDING_MS)} — your recording was kept`
      ),
  });
  const { state, level, elapsedMs } = recorder;

  const [holding, setHolding] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdingRef = useRef(false);
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);

  const ringScale = useTransform(level, [0, 1], [1.1, 1.6]);
  const ringOpacity = useTransform(level, [0, 1], [0.18, 0.45]);

  useEffect(
    () => () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    },
    []
  );

  function clearHoldTimer() {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  }

  // Every handler stops propagation: the bar's slide-between-tabs gesture lives on the
  // <ul> above, and a press that starts on Capture belongs to Capture.
  function handlePointerDown(e: ReactPointerEvent<HTMLAnchorElement>) {
    e.stopPropagation();
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (state === "requesting" || state === "recording" || state === "encoding") return;
    recorder.reset();
    pressOriginRef.current = { x: e.clientX, y: e.clientY };
    // The AudioContext is born now, inside the press, even though the microphone only
    // opens once the hold lands — see `prime` in use-voice-recorder.ts.
    recorder.prime();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-released pointer; the release still arrives, just unaimed.
    }
    clearHoldTimer();
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      holdingRef.current = true;
      setHolding(true);
      navigator.vibrate?.(10);
      recorder.start();
    }, HOLD_MS);
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLAnchorElement>) {
    e.stopPropagation();
    const origin = pressOriginRef.current;
    if (!origin || !holdTimerRef.current) return;
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > HOLD_SLOP_PX) {
      clearHoldTimer();
      recorder.cancel();
      pressOriginRef.current = null;
    }
  }

  function handleRelease(e: ReactPointerEvent<HTMLAnchorElement>) {
    e.stopPropagation();
    pressOriginRef.current = null;
    if (holdTimerRef.current) {
      // A tap. Drop the primed context and let the link's own click navigate.
      clearHoldTimer();
      recorder.cancel();
      return;
    }
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setHolding(false);
    // The click that trails a hold must not navigate a second time. On a timer, as in
    // `MobileNav.endDrag`: a touch that ended a long press may never fire a click at all,
    // and a flag left armed would eat the next unrelated tap.
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 500);
    recorder.resumeAudio();
    if (state === "recording") {
      // Hands off and navigates, via `onRecording`.
      recorder.stop();
    } else if (state === "requesting") {
      // Let go before the microphone opened — usually the first-ever permission prompt.
      // Nothing was said; open the page, where the mic is one tap away.
      recorder.cancel();
      router.push(VOICE_CAPTURE_HREF);
    }
    // Otherwise the six-minute cap already handed the note off, or an error already
    // said so. Nothing left to do.
  }

  const live = holding && (state === "requesting" || state === "recording");

  return (
    <Link
      href={VOICE_CAPTURE_HREF}
      draggable={false}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handleRelease}
      onPointerCancel={handleRelease}
      // A long press on a link opens the OS link menu (Android) or preview (iOS).
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          e.preventDefault();
        }
      }}
      className="relative flex w-full translate-y-1 flex-col items-center gap-0.5 px-1 py-1 text-[10px] font-medium text-primary select-none [-webkit-touch-callout:none]"
    >
      <AnimatePresence>
        {live && (
          <motion.span
            key="pill"
            aria-live="polite"
            className="pointer-events-none absolute -top-[4.75rem] left-1/2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-background/95 px-3 py-1.5 text-xs font-medium text-foreground tabular-nums shadow-lg ring-1 ring-border backdrop-blur"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DUR.fast, ease: EASE_HOUSE }}
          >
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-full bg-red-500",
                state === "recording" && !reducedMotion && "animate-pulse"
              )}
            />
            {state === "recording"
              ? `${formatElapsed(elapsedMs)} · Release to capture`
              : "Waiting for microphone…"}
          </motion.span>
        )}
      </AnimatePresence>

      <span className="h-5 w-5" aria-hidden />

      {/* The level ring, straight off the MotionValue like the capture page's mic. */}
      <AnimatePresence initial={false}>
        {live && state === "recording" && !reducedMotion && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute -top-5 left-1/2 h-12 w-12 -translate-x-1/2 rounded-full bg-primary"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DUR.fast, ease: EASE_HOUSE }}
            style={{ scale: ringScale, opacity: ringOpacity, y: HOLD_LIFT_PX }}
          />
        )}
      </AnimatePresence>

      <motion.span
        aria-hidden
        className="absolute -top-5 left-1/2 flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
        // No tap-shrink during a hold: it would pin the circle small for the whole note.
        whileTap={reducedMotion || holding ? undefined : { scale: 0.88 }}
        // Lifted as it grows, by the ~5px the extra 20% adds at the bottom edge, or the
        // bigger circle sits on the label under it.
        animate={
          holding && !reducedMotion ? { scale: 1.2, y: HOLD_LIFT_PX } : { scale: 1, y: 0 }
        }
        transition={reducedMotion ? { duration: 0 } : SPRING_TAP}
      >
        {holding ? (
          <Mic className="h-5 w-5" aria-hidden />
        ) : (
          <Icon className="h-5 w-5" aria-hidden />
        )}
      </motion.span>
      <span>{holding ? "Listening" : label}</span>
    </Link>
  );
}
