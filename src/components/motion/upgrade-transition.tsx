"use client";

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { motion, type Easing } from "motion/react";
import { BackControl } from "@/components/pricing/back-control";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * Robotic panel choreography for /upgrade.
 *
 * Every section of the page — header, heading, billing toggle, each plan card, the trust
 * row — is an independent `Panel` rather than one block that moves together. On mount each
 * flies in from its assigned side and lands with a spring "impact"; on Back, they reverse:
 * lift a beat, then launch away to the side they came from, staggered so the page reads as
 * disassembling itself rather than sliding off as one piece.
 *
 * Scoped to /upgrade: BackControl's `onBeforeNavigate` hook this relies on is opt-in, so
 * /pricing and the marketing docs keep their instant back navigation untouched.
 */

const ENTRY_STAGGER = 0.05;
const EXIT_STAGGER = 0.055;
const EXIT_DURATION = 0.42;
/** How far a panel hops up before launching sideways — the "pried loose" beat. */
const EXIT_LIFT = -16;
/** Clears the viewport regardless of a panel's own width or start position. */
const FLY_VW = 130;
/** How far above rest a panel starts on entry, for the incoming arc into its landing spot. */
const ENTRY_DROP = -28;
const ENTRY_SPRING = { type: "spring", stiffness: 480, damping: 19, mass: 0.9 } as const;
const EXIT_EASE: Easing[] = ["easeOut", "easeIn"];

type TransitionState = {
  exiting: boolean;
  reduced: boolean;
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
  /** The highest `order` any Panel inside this tree uses — keeps exit timing in step with
   *  however many stagger slots the page actually has, without the two drifting apart. */
  maxOrder: number;
  children: ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const [exiting, setExiting] = useState(false);
  // Captured at click time and run once every panel has cleared the screen — a ref because
  // invoking it must never itself trigger a re-render.
  const navigateRef = useRef<() => void>(() => {});

  function startExit(navigate: () => void) {
    navigateRef.current = navigate;
    if (reduced || exiting) {
      navigate();
      return;
    }
    setExiting(true);
    const totalMs = (maxOrder * EXIT_STAGGER + EXIT_DURATION) * 1000;
    window.setTimeout(() => navigateRef.current(), totalMs);
  }

  return (
    <TransitionContext.Provider value={{ exiting, reduced, startExit }}>
      {children}
    </TransitionContext.Provider>
  );
}

/** Drop-in for a bare `<BackControl />` inside a page wrapped in `UpgradeTransition`. */
export function TransitionBackControl() {
  const { startExit } = usePanelTransition();
  return <BackControl onBeforeNavigate={startExit} />;
}

function usePanelMotionProps(order: number, dir: "left" | "right") {
  const { exiting, reduced } = usePanelTransition();
  const dirMul = dir === "left" ? -1 : 1;
  const restX = "0vw";
  const flyX = `${dirMul * FLY_VW}vw`;

  return {
    initial: reduced ? false : { opacity: 0, x: flyX, y: ENTRY_DROP },
    animate: exiting
      ? { opacity: [1, 1, 0], x: [restX, restX, flyX], y: [0, EXIT_LIFT, EXIT_LIFT] }
      : { opacity: 1, x: restX, y: 0 },
    transition: exiting
      ? {
          duration: EXIT_DURATION,
          times: [0, 0.34, 1],
          ease: EXIT_EASE,
          delay: order * EXIT_STAGGER,
        }
      : { ...ENTRY_SPRING, delay: order * ENTRY_STAGGER },
  } as const;
}

/**
 * A page section that flies in from `dir` and lands, then (on Back) lifts and flies back
 * out the way it came. Panels sharing an `order` move together — the two plan cards use the
 * same slot with opposite `dir`s so they read as one pair splitting apart.
 */
export function Panel({
  order,
  dir,
  className,
  children,
}: {
  order: number;
  dir: "left" | "right";
  className?: string;
  children: ReactNode;
}) {
  const motionProps = usePanelMotionProps(order, dir);
  return (
    <motion.div className={className} {...motionProps}>
      {children}
    </motion.div>
  );
}

/** Same choreography as `Panel`, rendered as a `<header>` landmark. */
export function HeaderPanel({
  order,
  dir,
  className,
  children,
}: {
  order: number;
  dir: "left" | "right";
  className?: string;
  children: ReactNode;
}) {
  const motionProps = usePanelMotionProps(order, dir);
  return (
    <motion.header className={className} {...motionProps}>
      {children}
    </motion.header>
  );
}
