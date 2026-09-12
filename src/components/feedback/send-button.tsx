"use client";

import { Loader2 } from "lucide-react";
import { motion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * The feedback form's Send button, and the whole of its send gesture.
 *
 * One continuous idea in two moments rather than two unrelated events: while the
 * submission is in flight a light runs the button's border, and when it lands that same
 * light resolves into the button contracting to a circle around a drawn check. The wait
 * is what makes the arrival feel earned — a screenshot upload takes 1.5-4s, which is far
 * too long for the success beat to be the first thing that acknowledges the click.
 *
 * Deliberately small. Orbit's maximal case is the ~7s full-screen upgrade celebration in
 * `src/components/celebration/`; this is a different species, not a miniature of it. It
 * draws nothing outside the button and takes over nothing.
 *
 * Timing lives here; the DECISION to hold the window open for it lives in
 * `feedback-widget.tsx` (`SENT_HOLD_MS`), because only the widget can keep the panel
 * mounted. Keep the two in step: this gesture must finish inside that budget.
 */

/** `size="default"` is `h-8`, so this is both the button's height and the circle it becomes. */
const CIRCLE_PX = 32;

/**
 * The contraction.
 *
 * A spring rather than a duration, for the hair of overshoot as the pill snaps shut —
 * that squeeze is the tactile part of the whole interaction. Damped hard enough to settle
 * rather than bounce: the house rule is no elastic curves by reflex, and this is the one
 * deliberate exception, on a ~190ms move.
 */
const CONTRACT = { type: "spring", stiffness: 500, damping: 32 } as const;

/** The check draws itself. Held back a beat so it starts as the contraction settles. */
const DRAW = { duration: 0.2, ease: EASE_HOUSE, delay: 0.06 } as const;

export function SendButton({
  sending,
  sent,
  disabled,
  onClick,
}: {
  /** The submission is in flight. */
  sending: boolean;
  /** It landed. Owned by the widget's `sent` phase, not by this component. */
  sent: boolean;
  /** There is nothing to send yet. NOT set while sending — see below. */
  disabled: boolean;
  onClick: () => void;
}) {
  // The widget is mounted as a SIBLING of `AppShell` (`app/(app)/layout.tsx:122`), so the
  // `MotionConfig reducedMotion="user"` that wraps the rest of the app does not reach it.
  // Every motion value here has to gate itself.
  const reduced = usePrefersReducedMotion();

  const wrapRef = useRef<HTMLDivElement>(null);
  /**
   * The resting width, measured once.
   *
   * `width: auto` is not animatable, and the label's width depends on the font, so it
   * cannot be hardcoded. Measured before first paint and then held: the label never
   * changes, so this never needs to be re-read.
   *
   * `offsetWidth`, NOT `getBoundingClientRect()`. The panel mounts at `scale(0.28)` to play
   * its entrance, and a client rect is measured through every ancestor transform — so the
   * rect reports about 15px and the button would spend the rest of its life locked to a
   * sliver. `offsetWidth` is the layout width and ignores the scale.
   */
  const [restWidth, setRestWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (restWidth !== null) return;
    const el = wrapRef.current;
    if (el) setRestWidth(el.offsetWidth);
  }, [restWidth]);

  const width = sent ? CIRCLE_PX : restWidth;

  return (
    <motion.div
      ref={wrapRef}
      className="shrink-0"
      // `initial={false}` so adopting the measured width on mount is not itself an
      // animation — the button would visibly settle into place on every open.
      initial={false}
      animate={width === null ? undefined : { width }}
      transition={reduced ? { duration: 0 } : CONTRACT}
    >
      <Button
        type="button"
        data-slot="feedback-send"
        // Deliberately NOT disabled while sending or sent. `disabled:opacity-50`
        // (button.tsx:7) would dim a control that is actively working to half strength,
        // and the border sweep would be washed out with it. Clicks are blocked by
        // `pointer-events-none` below, and `send()` re-checks `canSend` anyway.
        disabled={disabled}
        aria-busy={sending || undefined}
        aria-disabled={sending || sent || undefined}
        onClick={onClick}
        className={cn(
          "relative w-full overflow-hidden",
          (sending || sent) && "pointer-events-none",
          // A stadium while it contracts, a circle when it lands. `border-radius` is not
          // in the button's transition list, so this snaps — which is what we want: the
          // shape is already right at every width the contraction passes through.
          sent && "rounded-full",
          sending && !reduced && "send-signal"
        )}
      >
        <motion.span
          className="inline-flex items-center gap-1.5"
          initial={false}
          animate={{ opacity: sent ? 0 : 1 }}
          transition={{ duration: reduced ? 0 : DUR.fast, ease: EASE_HOUSE }}
        >
          {/* Reduced motion gets the spinner back, because the sweep it replaces is
              hidden there — see the `.send-signal` block in globals.css. */}
          {sending && reduced && <Loader2 className="size-3.5 animate-spin" />}
          Send
        </motion.span>

        {sent && <SentCheck reduced={reduced} />}
      </Button>
    </motion.div>
  );
}

/**
 * Drawn, not revealed.
 *
 * A check that fades in is a state; a check that strokes itself in is an event, and an
 * event is what just happened. Absolutely positioned so the contracting width and the
 * button's padding cannot push it around mid-draw.
 *
 * `aria-hidden`: the success is announced by the `toast.success` the panel still fires,
 * through sonner's own live region. Two announcements of one event is worse than none.
 */
function SentCheck({ reduced }: { reduced: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="absolute inset-0 m-auto size-4"
    >
      <motion.path
        d="M20 6 9 17l-5-5"
        initial={reduced ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={reduced ? { duration: 0 } : DRAW}
      />
    </svg>
  );
}
