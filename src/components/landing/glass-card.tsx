"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { SPRING_TAP } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * How far the card gives under a press.
 *
 * Deliberately nowhere near the 0.88 the Capture button uses (`SPRING_TAP`'s other call
 * site): that is a 44px target, and the same ratio on a 1000px card reads as the panel
 * collapsing rather than as a surface being pressed. At 0.99 a full-width card still
 * travels ~10px, which is plenty to feel — the press wants to be felt, not watched.
 */
const PRESS_SCALE = 0.99;

/**
 * Elements that own their own click. A press starting on one of these is someone using
 * the control, not pressing the card — most visibly on the interest-list card in the
 * finale, where the whole panel wrapping the email field would otherwise squish every
 * time someone clicked into it.
 */
const INTERACTIVE = "a, button, input, textarea, select, label";

/**
 * A glass surface on the marketing landing page, with press feedback.
 *
 * Every `.landing-glass` card renders through here so the press cannot be forgotten when
 * a card is added — `scripts/smoke-landing-cards.ts` asserts that no component applies
 * the class directly.
 *
 * The card is NOT a button and gains no click behaviour: nothing opens, nothing
 * navigates. The animation exists so a surface that looks physical answers when you
 * touch it. That is also why there is no `cursor: pointer`, no role and no tabindex —
 * promising a destination the card does not have would be worse than staying inert.
 *
 * Callers stay server components: the copy arrives as `children` and is rendered on the
 * server, the same arrangement `<Reveal>` already uses to wrap these sections.
 */
export function GlassCard({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [pressed, setPressed] = useState(false);

  // Driven from explicit pointer handlers rather than motion's `whileTap`, which fires
  // for any pointer-down inside the element and cannot be made conditional on what was
  // actually hit — the INTERACTIVE check above needs the event target.
  const press = (e: React.PointerEvent) => {
    if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return;
    setPressed(true);
  };
  const release = () => setPressed(false);

  return (
    <motion.div
      className={cn("landing-glass", className)}
      // Reduced motion gets the surface and none of the movement. `animate` is left at
      // rest rather than skipping the handlers so there is one code path either way.
      animate={{ scale: pressed && !reducedMotion ? PRESS_SCALE : 1 }}
      transition={reducedMotion ? { duration: 0 } : SPRING_TAP}
      onPointerDown={press}
      onPointerUp={release}
      // A pointer that leaves mid-press, or is stolen by a scroll, has to let the card
      // back up — otherwise it stays depressed with nothing to release it.
      onPointerLeave={release}
      onPointerCancel={release}
    >
      {children}
    </motion.div>
  );
}
