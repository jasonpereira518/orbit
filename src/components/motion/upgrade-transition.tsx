"use client";

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { BackControl } from "@/components/pricing/back-control";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * Assembly choreography for /upgrade: the page builds itself a piece at a time, the way a
 * brick is placed onto a stack.
 *
 * Every section — header, heading, billing toggle, each plan card, the trust row — is an
 * independent `Panel` holding one slot in the sequence. On mount each descends a short
 * distance onto its own position and seats; on Back they lift back off in reverse order,
 * last piece placed removed first.
 *
 * The motion is deliberately small. An earlier version flew panels in from beyond the
 * viewport edge on an under-damped spring, which read as arrival-as-spectacle: the eye
 * followed the travel and the landing was incidental. Placement is the opposite — the
 * interesting moment is contact, so the travel is short enough to be almost incidental and
 * the spring is damped to a single pixel of overshoot. That residual pixel is what reads as
 * a click; more than that reads as a bounce.
 *
 * Scoped to /upgrade: BackControl's `onBeforeNavigate` hook this relies on is opt-in, so
 * /pricing and the marketing docs keep their instant back navigation untouched.
 */

/** Perceptible as piece-after-piece without making the full build feel slow. */
const ENTRY_STAGGER = 0.07;
const EXIT_STAGGER = 0.05;
const EXIT_DURATION = 0.16;

/** How far above its resting place a piece starts. Short: this is a placement, not a fall. */
const ENTRY_RISE = -14;
/** How far a piece lifts off its studs on the way out. */
const EXIT_LIFT = -10;
/** Seat compression — the give of a brick pressing into place, and releasing on the way out. */
const SEATED_SCALE = 1;
const UNSEATED_SCALE = 0.985;

/** Stiff and well damped: settles in ~0.22s with about a pixel of overshoot. */
const ENTRY_SPRING = { type: "spring", stiffness: 620, damping: 30, mass: 0.7 } as const;
/**
 * Opacity resolves well before the spring settles, so a piece exists and *then* seats.
 * Fading across the whole descent would read as materializing rather than being placed.
 */
const ENTRY_FADE_DURATION = 0.09;

type TransitionState = {
  exiting: boolean;
  reduced: boolean;
  maxOrder: number;
  startExit: (navigate: () => void) => void;
};

const TransitionContext = createContext<TransitionState | null>(null);

function usePanelTransition() {
  const ctx = useContext(TransitionContext);
  if (!ctx) throw new Error("Panel/TransitionBackControl used outside UpgradeTransition");
  return ctx;
}

export function UpgradeTransition({
  maxOrder,
  children,
}: {
  /** The highest `order` any Panel inside this tree uses. Drives both the reverse exit
   *  ordering and the navigation delay, so neither can drift out of step with however many
   *  slots the page actually has. */
  maxOrder: number;
  children: ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const [exiting, setExiting] = useState(false);
  // Captured at click time and run once every piece has lifted away — a ref because
  // invoking it must never itself trigger a re-render.
  const navigateRef = useRef<() => void>(() => {});

  function startExit(navigate: () => void) {
    navigateRef.current = navigate;
    if (reduced || exiting) {
      navigate();
      return;
    }
    setExiting(true);
    // The last piece to start is order 0, delayed by the full stagger run.
    const totalMs = (maxOrder * EXIT_STAGGER + EXIT_DURATION) * 1000;
    window.setTimeout(() => navigateRef.current(), totalMs);
  }

  return (
    <TransitionContext.Provider value={{ exiting, reduced, maxOrder, startExit }}>
      {children}
    </TransitionContext.Provider>
  );
}

/** Drop-in for a bare `<BackControl />` inside a page wrapped in `UpgradeTransition`. */
export function TransitionBackControl() {
  const { startExit } = usePanelTransition();
  return <BackControl onBeforeNavigate={startExit} />;
}

function usePanelMotionProps(order: number) {
  const { exiting, reduced, maxOrder } = usePanelTransition();

  if (exiting) {
    // Reverse order: the last piece placed is the first one taken off.
    const delay = (maxOrder - order) * EXIT_STAGGER;
    return {
      initial: false,
      animate: { opacity: 0, y: EXIT_LIFT, scale: UNSEATED_SCALE },
      transition: { duration: EXIT_DURATION, ease: "easeIn", delay },
    } as const;
  }

  const delay = order * ENTRY_STAGGER;
  return {
    initial: reduced
      ? false
      : { opacity: 0, y: ENTRY_RISE, scale: UNSEATED_SCALE },
    animate: { opacity: 1, y: 0, scale: SEATED_SCALE },
    transition: {
      ...ENTRY_SPRING,
      delay,
      opacity: { duration: ENTRY_FADE_DURATION, ease: "easeOut", delay },
    },
  } as const;
}

/**
 * One section of the page, holding slot `order` in the assembly sequence: it descends onto
 * its position and seats, then lifts back off when the page comes apart.
 */
export function Panel({
  order,
  className,
  children,
}: {
  order: number;
  className?: string;
  children: ReactNode;
}) {
  const motionProps = usePanelMotionProps(order);
  return (
    <motion.div className={className} {...motionProps}>
      {children}
    </motion.div>
  );
}

/** Same choreography as `Panel`, rendered as a `<header>` landmark. */
export function HeaderPanel({
  order,
  className,
  children,
}: {
  order: number;
  className?: string;
  children: ReactNode;
}) {
  const motionProps = usePanelMotionProps(order);
  return (
    <motion.header className={className} {...motionProps}>
      {children}
    </motion.header>
  );
}
