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
import { ArrowUp, Loader2, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/** Straight up and clear of the button, without reaching the message above it. */
const LAUNCH_Y = -20;

export function ComposerSendButton({
  mode,
  busy,
  disabled,
  onClick,
  onStop,
}: {
  /** "recall" reuses this control to pull the last message back. */
  mode: "send" | "recall";
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  /** Given, the button becomes a stop control while the answer streams. */
  onStop?: () => void;
}) {
  const reduced = usePrefersReducedMotion();
  const duration = reduced ? 0 : DUR.slow;
  // While streaming this is the only control in reach, so it stops rather than sits
  // disabled — a long answer the user no longer wants had no way out before.
  const stopping = busy && Boolean(onStop);
  const label = stopping ? "Stop generating" : mode === "send" ? "Send" : "Recall last message";

  return (
    <Button
      type="button"
      data-slot="chat-send"
      disabled={stopping ? false : disabled}
      className={cn(
        "size-9 shrink-0 rounded-full",
        // Red while it means "stop", so it reads as a different control from the send arrow
        // it just replaced — the same button in the same place doing the opposite.
        stopping
          ? "bg-destructive text-white hover:bg-destructive/90"
          : "bg-primary text-primary-foreground hover:bg-primary/90"
      )}
      onClick={stopping ? onStop : onClick}
      aria-label={label}
      title={label}
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
              {stopping ? (
                <Square className="size-3 fill-current" />
              ) : (
                <Loader2 className="size-4 animate-spin" />
              )}
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
