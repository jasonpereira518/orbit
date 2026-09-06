"use client";

/**
 * The composer's send control: a paper plane that flies away when you send.
 *
 * The gesture is one idea — the plane you pressed leaves toward the top right as the
 * request takes off, and when the answer lands a fresh one glides back in from the bottom
 * left. Same restraint as `components/feedback/send-button.tsx`: a single small motion,
 * drawing nothing outside its own box.
 *
 * The flight is driven by `busy`, not by the click. Sending flips `busy` in the same tick,
 * so anything keyed off the click alone gets unmounted mid-animation and never plays — the
 * plane's departure IS the request leaving, which is also the more honest thing to show.
 */

import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/** Far enough to read as "gone", short enough not to reach the composer's edge. */
const FLIGHT = { x: 18, y: -18 } as const;

export function SendPlaneButton({
  mode,
  busy,
  disabled,
  onClick,
}: {
  /** "recall" reuses this control to pull the last message back — it keeps the arrow. */
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
      className="h-11 w-11 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
      onClick={onClick}
      aria-label={mode === "send" ? "Send" : "Recall last message"}
    >
      {/* Fixed box with the glyphs stacked inside it, so the outgoing plane and the
          incoming spinner overlap during the handover instead of shifting the layout. */}
      <span className="relative inline-flex size-4 items-center justify-center">
        <AnimatePresence initial={false} mode="sync">
          {busy ? (
            <motion.span
              key="busy"
              className="absolute inset-0 inline-flex items-center justify-center"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              // Held back so the plane is clear of the box before the spinner appears.
              transition={{ duration, ease: EASE_HOUSE, delay: reduced ? 0 : DUR.fast }}
            >
              <Loader2 className="size-4 animate-spin" />
            </motion.span>
          ) : (
            <motion.span
              key="plane"
              className="absolute inset-0 inline-flex items-center justify-center"
              initial={{ x: -9, y: 9, opacity: 0, scale: 0.85 }}
              animate={{ x: 0, y: 0, opacity: 1, scale: 1 }}
              exit={{ ...FLIGHT, opacity: 0, scale: 0.8 }}
              transition={{ duration, ease: EASE_HOUSE }}
            >
              {/* Recall is not a send, so it keeps the old arrow. Swapping the glyph is
                  safe: the key is stable, so it does not retrigger the flight. */}
              {mode === "send" ? (
                <Send className="size-4" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </Button>
  );
}
