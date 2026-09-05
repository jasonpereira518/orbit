"use client";

/**
 * The mic control for the chat composer.
 *
 * One idea, executed once: while the recogniser is listening, a ring breathes out of the
 * button in time with your speech. Presentation only — it calls no hook and owns no
 * state, so the same control can later be driven from the ask bar.
 *
 * Modelled on `components/feedback/send-button.tsx`, which is the house reference for an
 * inline animated control: restrained, drawing nothing outside its own box.
 */

import { Loader2, Mic } from "lucide-react";
import { motion, useTransform, type MotionValue } from "motion/react";

import { Button } from "@/components/ui/button";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { useDelayedLoading } from "@/lib/use-delayed-loading";
import { cn } from "@/lib/utils";
import type { DictationState } from "@/lib/dictation";

export function DictationButton({
  state,
  level,
  disabled,
  onToggle,
}: {
  state: DictationState;
  /** 0..1 speech energy. A MotionValue so the ring never re-renders the thread. */
  level: MotionValue<number>;
  disabled: boolean;
  onToggle: (source: "pointer" | "keyboard") => void;
}) {
  const reduced = usePrefersReducedMotion();

  // An already-granted mic resolves in ~20ms; without the delay that is a spinner flash.
  const showSpinner = useDelayedLoading(state === "requesting", 150);

  const scale = useTransform(level, [0, 1], [1.02, 1.3]);
  const opacity = useTransform(level, [0, 1], [0.1, 0.42]);

  const listening = state === "listening" || state === "requesting";
  const errored = state === "error";

  if (state === "unsupported") return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-slot="chat-dictate"
      // Not `disabled` while requesting: `disabled:opacity-50` would dim a control that
      // is actively working. Clicks are blocked below instead.
      disabled={disabled}
      aria-busy={state === "requesting" || undefined}
      aria-disabled={state === "requesting" || undefined}
      aria-pressed={state === "listening"}
      aria-label={listening ? "Stop dictating" : "Dictate"}
      title={listening ? "Stop dictating" : "Dictate"}
      onClick={(e) => onToggle(e.detail === 0 ? "keyboard" : "pointer")}
      className={cn(
        "relative h-11 w-11 shrink-0 overflow-visible text-muted-foreground",
        "transition-colors",
        state === "requesting" && "pointer-events-none",
        listening && "bg-primary/12 text-primary hover:bg-primary/16 hover:text-primary",
        errored && "text-destructive",
      )}
    >
      {/* The liveness. Driven by a MotionValue, so no React render per frame — and no
          infinite keyframe loop for `reducedMotion="user"` to leave spinning at zero. */}
      {state === "listening" && !reduced && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-lg bg-primary"
          style={{ scale, opacity }}
        />
      )}
      {/* Reduced motion keeps the state legible without the ring. */}
      {state === "listening" && reduced && (
        <span aria-hidden className="pointer-events-none absolute inset-0 rounded-lg bg-primary/15" />
      )}

      {showSpinner ? (
        <Loader2 className="relative size-4 animate-spin" />
      ) : (
        <motion.span
          className="relative inline-flex"
          initial={false}
          // A single restrained gesture on arrival, matching the house register.
          animate={{ scale: state === "listening" ? 1.06 : 1 }}
          transition={{ duration: reduced ? 0 : DUR.fast, ease: EASE_HOUSE }}
        >
          {/* Stays `Mic` while listening on purpose: `MicOff` reads as "muted", which is
              the opposite of what is happening. */}
          <Mic className="size-4" />
        </motion.span>
      )}
    </Button>
  );
}
