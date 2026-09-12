"use client";

/**
 * The composer's send control: a circular button whose arrow launches when you send.
 *
 * The arrow you pressed rises out of the top of the button as the request goes out, and
 * when the answer lands a fresh one climbs in from below. Same restraint as
 * `components/feedback/send-button.tsx` — one small motion, nothing drawn outside its box.
 *
 * The launch is driven by `busy`, not by the click. That is not incidental: sending flips
 * `busy` in the same tick, so anything keyed off the click alone gets unmounted
 * mid-animation and never plays. Tying it to `busy` also makes the arrow's departure mean
 * the thing it looks like it means — the request leaving.
 */

import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/** Straight up and clear of the button, without reaching the message above it. */
const LAUNCH_Y = -20;

export function ComposerSendButton({
  mode,
  busy,
  disabled,
  onClick,
}: {
  /** "recall" reuses this control to pull the last message back. */
  mode: "send" | "recall";
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const reduced = usePrefersReducedMotion();
  const duration = reduced ? 0 : DUR.slow;

  return (
    <Button
      type="button"
      data-slot="chat-send"
      disabled={disabled}
      className="size-9 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
      onClick={onClick}
      aria-label={mode === "send" ? "Send" : "Recall last message"}
      title={mode === "send" ? "Send" : "Recall last message"}
    >
      {/* Fixed box with the glyphs stacked inside, so the departing arrow and the arriving
          spinner overlap during the handover instead of shifting the button's layout. */}
      <span className="relative inline-flex size-4 items-center justify-center overflow-hidden">
        <AnimatePresence initial={false} mode="sync">
          {busy ? (
            <motion.span
              key="busy"
              className="absolute inset-0 inline-flex items-center justify-center"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              // Held back so the arrow is clear of the box before the spinner appears.
              transition={{ duration, ease: EASE_HOUSE, delay: reduced ? 0 : DUR.fast }}
            >
              <Loader2 className="size-4 animate-spin" />
            </motion.span>
          ) : (
            <motion.span
              key="arrow"
              className="absolute inset-0 inline-flex items-center justify-center"
              initial={{ y: 14, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: LAUNCH_Y, opacity: 0 }}
              transition={{ duration, ease: EASE_HOUSE }}
            >
              <ArrowUp className="size-4" />
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </Button>
  );
}
