"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { motion } from "motion/react";
import { BackControl } from "@/components/pricing/back-control";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { CHRONO_IN, CHRONO_RESOLVE, tangentForSlot } from "@/lib/warp/chrono";
import { arrivedBy, useWarp } from "@/components/warp/warp-provider";

/**
 * Choreography for /upgrade's arrival, in one of two modes.
 *
 * "assemble" is the default: the page builds itself a piece at a time, the way a brick is
 * placed onto a stack. Every section — header, heading, billing toggle, each plan card, the
 * trust row — is an independent `Panel` holding one slot in the sequence. On mount each
 * descends a short distance onto its own position and seats; on Back they lift back off in
 * reverse order, last piece placed removed first. This is what /pricing's "Upgrade to Orbit
 * Pro" link produces, and what a direct load produces too.
 *
 * The motion is deliberately small. An earlier version flew panels in from beyond the
 * viewport edge on an under-damped spring, which read as arrival-as-spectacle: the eye
 * followed the travel and the landing was incidental. Placement is the opposite — the
 * interesting moment is contact, so the travel is short enough to be almost incidental and
 * the spring is damped to a single pixel of overshoot. That residual pixel is what reads as
 * a click; more than that reads as a bounce.
 *
 * "resolve" is the other arrival, produced only by the Settings time warp (a chrono
 * journey). Someone who time-warped in did not watch this page being built, so panels
 * condense out of the star trails instead of being placed — see the constants below.
 * Crucially the entrance is driven by the RUN'S PHASE, not by this component mounting:
 * the page mounts behind a fully opaque stage, up to a second before the arcs start
 * collapsing, so panels hold smeared until deceleration begins and then sharpen across
 * the stage's reveal. Sharpening on mount would finish the whole entrance behind cover,
 * which is "sky cleared, then page faded in" — the thing this arrival is not. Back
 * in this mode is the provider's rewind, not the assembly played backwards: there is no
 * click handler here, because `BackControl` owns Back. Instead the panels watch
 * `useWarp().run.phase` and, once it enters the inbound leg (`inbound` or `landing`),
 * smear themselves back into the exposure in reverse order — the mirror of how they
 * condensed in, not the brick-lift of the assemble exit.
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

/* ── Resolving out of the exposure ──
 *
 * The other arrival. Someone who time-warped in did not watch this page being
 * built, so it must not assemble — it condenses out of the star trails they
 * travelled through. Each panel starts smeared along the tangent of its own
 * arc and sharpens to rest.
 *
 * Faster than the assembly and eased rather than sprung: a spring's overshoot
 * is the click of a brick seating, which is the wrong verb for something that
 * was already there when you arrived. */
const RESOLVE_STAGGER = CHRONO_RESOLVE.stagger / 1000;
const RESOLVE_DURATION = CHRONO_RESOLVE.duration / 1000;
/**
 * Held smeared until deceleration begins, then released after this long.
 *
 * The entrance used to run on MOUNT, which is up to a second before the stage
 * starts lifting: the panels were fully resolved before anything could be seen
 * of them, which is "sky cleared, then page faded in" — the one thing this
 * arrival is not supposed to be. Keyed off the run's phase instead, and offset
 * so the sharpening lands inside the reveal window rather than in front of it.
 */
const RESOLVE_LEAD = CHRONO_RESOLVE.lead / 1000;
const RESOLVE_BLUR = 8;
const RESOLVE_OFFSET = 14;
const RESOLVE_SCALE = 1.015;
const RESOLVE_EASE = [0.22, 0.61, 0.36, 1] as const;

/** How long the rewind's dissolve takes, derived from the same beat table the
 *  chrono stage reads so this can never drift out of step with it. */
const DISSOLVE_DURATION = (CHRONO_IN.dissolve[1] - CHRONO_IN.dissolve[0]) / 1000;

type TransitionState = {
  exiting: boolean;
  reduced: boolean;
  maxOrder: number;
  /** "assemble" is the brick placement, for /pricing arrivals and direct
   *  loads. "resolve" is the time warp's condensation. */
  mode: "assemble" | "resolve";
  /** True once a chrono rewind is under way and the panels should smear back
   *  into the exposure. */
  rewinding: boolean;
  /** True while the warp that is delivering this page is still outbound: the
   *  panels sit smeared behind full cover, waiting to be released. */
  holding: boolean;
  /** Seconds to wait, once released, before the first panel sharpens. */
  resolveLead: number;
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
  const { run } = useWarp();
  const [exiting, setExiting] = useState(false);
  const [mode, setMode] = useState<"assemble" | "resolve">("assemble");
  // Only "inbound" and "landing" are the rewind home — "cruise" and
  // "arriving" belong to the outbound trip that condenses this page IN, and
  // must not be mistaken for the rewind that dissolves it back out.
  const rewinding =
    run.journey === "chrono" &&
    (run.phase === "inbound" || run.phase === "landing");
  /**
   * Whether this page mounted into a warp that is still on its way here.
   *
   * Captured once, at mount, and never recomputed. A chrono arrival mounts
   * mid-run behind full cover and its panels must wait for the reveal; every
   * other route into resolve mode — a reload after a warp, a run that was
   * skipped or had already settled — has no reveal to wait behind and must
   * resolve at once. `useState`'s lazy initialiser rather than a ref so
   * nothing is written during a render, and constant rather than derived
   * per-render so the delay cannot change underneath a running animation when
   * the run settles to "idle" partway through the sharpening.
   */
  const [arrivedMidRun] = useState(
    () =>
      run.journey === "chrono" &&
      (run.phase === "outbound" || run.phase === "cruise"),
  );
  const holding =
    mode === "resolve" &&
    !reduced &&
    arrivedMidRun &&
    (run.phase === "outbound" || run.phase === "cruise");
  const resolveLead = arrivedMidRun && !reduced ? RESOLVE_LEAD : 0;
  // Captured at click time and run once every piece has lifted away — a ref because
  // invoking it must never itself trigger a re-render.
  const navigateRef = useRef<() => void>(() => {});
  // The pending exit navigation. Held so a second Back press can cancel it
  // instead of racing it, and so leaving the page cancels it outright.
  const exitTimer = useRef<number | null>(null);

  // sessionStorage cannot be read during render without breaking hydration —
  // same reason `usePrefersReducedMotion` starts false and corrects itself.
  // The switch is invisible because it happens while the stage is still fully
  // opaque over this page: the assembly's first frames are behind the sky, the
  // same trick that hides /pricing's skeleton during a cruise hold.
  //
  // The wrapper is not indirection for its own sake and does not inline:
  // `react-hooks/set-state-in-effect` flags a bare setState in an effect body,
  // and the repo's lint budget has no room for one. Verified — removing it
  // costs exactly one error.
  useEffect(() => {
    const resolveMode = () => {
      if (arrivedBy() === "chrono") setMode("resolve");
    };
    resolveMode();
  }, []);

  // Leaving by any other door — the "Orbit home" link beside Back, say —
  // must take the pending navigation with it. Otherwise the timer fires from
  // whatever page the visitor chose instead and yanks them back to /upgrade.
  useEffect(
    () => () => {
      if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
    },
    [],
  );

  function startExit(navigate: () => void) {
    navigateRef.current = navigate;
    if (reduced || exiting) {
      // A second press means "stop waiting", so it still leaves immediately —
      // but the first press's timer has to be cancelled first, or both fire
      // and the visitor goes back TWO entries.
      if (exitTimer.current !== null) {
        window.clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
      navigate();
      return;
    }
    setExiting(true);
    // The last piece to start is order 0, delayed by the full stagger run.
    const totalMs = (maxOrder * EXIT_STAGGER + EXIT_DURATION) * 1000;
    exitTimer.current = window.setTimeout(() => {
      exitTimer.current = null;
      navigateRef.current();
    }, totalMs);
  }

  return (
    <TransitionContext.Provider
      value={{
        exiting,
        reduced,
        maxOrder,
        mode,
        rewinding,
        holding,
        resolveLead,
        startExit,
      }}
    >
      {children}
    </TransitionContext.Provider>
  );
}

/** Drop-in for a bare `<BackControl />` inside a page wrapped in
 *  `UpgradeTransition`. In resolve mode it steps out of the way: the visitor
 *  time-warped in, so Back is the provider's rewind, not the assembly played
 *  backwards. */
export function TransitionBackControl() {
  const { startExit, mode } = usePanelTransition();
  if (mode === "resolve") return <BackControl />;
  return <BackControl onBeforeNavigate={startExit} />;
}

function usePanelMotionProps(order: number) {
  const { exiting, reduced, maxOrder, mode, rewinding, holding, resolveLead } =
    usePanelTransition();

  if (mode === "resolve") {
    const t = tangentForSlot(order, maxOrder);
    const smeared = {
      opacity: 0,
      filter: `blur(${RESOLVE_BLUR}px)`,
      scale: RESOLVE_SCALE,
      x: t.x * RESOLVE_OFFSET,
      y: t.y * RESOLVE_OFFSET,
    };

    if (rewinding) {
      // Reverse stagger, as the assembly's exit already does: the last thing
      // to resolve is the first to go.
      return {
        initial: false,
        animate: smeared,
        transition: {
          duration: DISSOLVE_DURATION,
          ease: "easeIn",
          delay: (maxOrder - order) * EXIT_STAGGER,
        },
      } as const;
    }

    if (holding) {
      // Still outbound: hold smeared behind the fully opaque stage. This is a
      // snap, not an animation — nothing can see it — and animating TO the
      // smeared state rather than initialising at it is also what sidesteps
      // Motion capturing `initial` exactly once, at a mount where this page's
      // mode was still "assemble" and the smear would never have been applied.
      return {
        initial: false,
        animate: smeared,
        transition: { duration: 0 },
      } as const;
    }

    return {
      initial: reduced ? false : smeared,
      animate: { opacity: 1, filter: "blur(0px)", scale: 1, x: 0, y: 0 },
      transition: {
        duration: RESOLVE_DURATION,
        ease: RESOLVE_EASE,
        // `resolveLead` is 0 unless a warp is actually landing this page; when
        // one is, it puts the sharpening inside the reveal window instead of
        // finishing before it opens.
        delay: resolveLead + order * RESOLVE_STAGGER,
      },
    } as const;
  }

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
