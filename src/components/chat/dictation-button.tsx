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
import { AnimatePresence, motion, useTransform, type MotionValue } from "motion/react";


import { Button } from "@/components/ui/button";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { useDelayedLoading } from "@/lib/use-delayed-loading";
import { cn } from "@/lib/utils";
import type { DictationState } from "@/lib/dictation";


/**
 * The listening glyph: four bars that ride the speech energy.
 *
 * Each bar maps `level` through its own range so they move as a group without marching in
 * lockstep — a single shared transform reads as a slider, not a voice. Driven entirely by
 * the MotionValue, so none of this re-renders the chat thread.
 */
function LevelBars({ level, reduced }: { level: MotionValue<number>; reduced: boolean }) {
  return (
    <span aria-hidden className="relative flex h-4 items-center gap-[2px]">
      {LEVEL_BAR_RANGES.map((range, i) => (
        <LevelBar key={i} level={level} range={range} reduced={reduced} />
      ))}
    </span>
  );
}

/** Min/max height in px per bar. The outer pair stay shorter, so the shape reads as a voice. */
const LEVEL_BAR_RANGES: Array<[min: number, max: number]> = [
  [3, 9],
  [5, 15],
  [4, 12],
  [3, 8],
];

function LevelBar({
  level,
  range,
  reduced,
}: {
  level: MotionValue<number>;
  range: [number, number];
  reduced: boolean;
}) {
  const height = useTransform(level, [0, 1], range);
  return (
    <motion.span
      className="w-[2.5px] rounded-full bg-current"
      // Reduced motion keeps the bars, frozen at a resting height: the shape still says
      // "listening" without anything moving.
      style={reduced ? { height: range[0] + 2 } : { height }}
    />
  );
}

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
      // No `title` while listening: the bubble below already says it, and a native
      // tooltip next to it is two tooltips saying nearly the same thing.
      title={listening ? undefined : "Dictate"}
      onClick={(e) => onToggle(e.detail === 0 ? "keyboard" : "pointer")}
      className={cn(
        "relative size-9 shrink-0 overflow-visible rounded-full text-muted-foreground",
        "transition-colors",
        state === "requesting" && "pointer-events-none",
        // Solid, not a tint: at a glance the only question that matters is "is it on?".
        state === "listening" &&
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary hover:text-primary-foreground",
        state === "requesting" && "bg-primary/12 text-primary",
        errored && "text-destructive",
      )}
    >
      {/* The state cue, floating over the mic rather than sitting in a row under the
          composer — a row shifted the suggestion chips down every time dictation started.
          `aria-hidden` because the composer's sr-only live region already announces this;
          without it screen readers say it twice. */}
      <AnimatePresence initial={false}>
        {listening && (
          <motion.span
            aria-hidden
            key="cue"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: reduced ? 0 : DUR.fast, ease: EASE_HOUSE }}
            className={cn(
              // mb-3, not mb-2: the button sits inside the pill's padding, so a smaller
              // offset leaves the bubble overlapping the pill's top border.
              "absolute bottom-full left-1/2 z-20 mb-3 -translate-x-1/2",
              "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full",
              "border border-border/70 bg-popover px-2.5 py-1 text-[11px] text-primary shadow-md",
              // Load-bearing: the bubble overhangs the composer and would otherwise
              // swallow clicks aimed at the text field.
              "pointer-events-none",
            )}
          >
            <span className="relative flex size-1.5">
              {!reduced && (
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-70" />
              )}
              <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
            </span>
            {state === "requesting" ? "Starting…" : "Listening — Esc to stop"}
          </motion.span>
        )}
      </AnimatePresence>

      {/* The halo. Driven by a MotionValue, so no React render per frame — and no infinite
          keyframe loop for `reducedMotion="user"` to leave spinning at zero. */}
      {state === "listening" && !reduced && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full bg-primary"
          style={{ scale, opacity }}
        />
      )}

      {showSpinner ? (
        <Loader2 className="relative size-4 animate-spin" />
      ) : state === "listening" ? (
        // Bars, not a mic glyph: a mic means "you can dictate", moving bars mean "it is
        // hearing you right now". `MicOff` was rejected — it reads as muted, the opposite.
        <LevelBars level={level} reduced={reduced} />
      ) : (
        <motion.span
          className="relative inline-flex"
          initial={false}
          transition={{ duration: reduced ? 0 : DUR.fast, ease: EASE_HOUSE }}
        >
          <Mic className="size-4" />
        </motion.span>
      )}
    </Button>
  );
}
