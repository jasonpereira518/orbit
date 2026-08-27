"use client";

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { motion } from "motion/react";
import { BackControl } from "@/components/pricing/back-control";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import {
  CHRONO_RESOLVE,
  liftScheduleForSlot,
  partDirection,
  partDistance,
  partScheduleForSlot,
  tangentForSlot,
} from "@/lib/warp/chrono";
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
 * lift and then fly out of the frame in reverse order — each to whichever side of the
 * viewport centre it is already nearer, so the two plan cards part like curtains.
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

/* ── Leaving: lift, then part ──
 *
 * The way home for a visitor who time-warped in. Not the mirror of the
 * arrival: a panel that smears back into the exposure it condensed out of is
 * tidy, but it is also 380ms of nothing much happening at the exact moment
 * someone has asked to leave. Two beats instead.
 *
 * The rise matters more than its length suggests. Flying straight sideways
 * from rest reads as a slide — a thing on a track — whereas lifting first
 * reads as something releasing before it goes, and the release is what makes
 * the flight feel like the panel's own move rather than the page scrolling
 * sideways. Its length and its delay come from `liftScheduleForSlot`, which
 * takes the same per-slot offset the flight does, so the two beats stay in
 * step whatever the slot count.
 *
 * Then the flight, accelerating away instead of coasting to the edge — on
 * PART_EASE, which is deliberately NOT Motion's "easeIn" — and far enough to
 * clear the frame whatever the panel's width. Its length and its reverse
 * stagger both come from `partScheduleForSlot`, which fits the whole cohort
 * inside `CHRONO_IN.part` — so the cover cannot come up over a panel that has
 * not left yet, for any slot count. */
/**
 * The flight's curve. Accelerating, but NOT from a standstill.
 *
 * Was the string `"easeIn"`, which Motion resolves to
 * `cubicBezier(0.42, 0, 1, 1)` — checked, not assumed: see
 * `motion-utils/dist/es/easing/ease.mjs` for the JS path and
 * `motion-dom/.../waapi/easing/supported.mjs`, which maps the same name to
 * CSS `ease-in`, for the WAAPI one. Its initial velocity is exactly zero.
 * By the time the flight starts the rise is 75% through an easeOut and so
 * visually finished, which leaves the first frames of the flight as the only
 * thing on screen — and easeIn spends them barely moving: 0.28% of the
 * distance on frame one, 1.09% on frame two, or 4px then 16px on a 1440px
 * viewport. The beat has to read as "lift, THEN fly", and a beat that has to
 * be legible cannot begin with nothing happening.
 *
 * This curve starts at 0.32x the flight's average velocity rather than 0x and
 * finishes at 1.55x rather than easeIn's 1.71x, accelerating monotonically
 * throughout — so the panel commits on the first frame and is still plainly
 * speeding up when it leaves. Frame one goes from 0.28% to 1.38% of the
 * distance; one tenth of the way in, from 1.70% to 3.89%.
 *
 * At the HALFWAY point it is 34.2% against easeIn's 31.5% — barely moved, and
 * deliberately. The defect is the standstill at the top of the move, not the
 * shape of the middle; a curve flattened enough to shift the midpoint much
 * would be trading the acceleration this flight is supposed to have for a
 * constant-speed slide, which is the "thing on a track" reading the rise
 * exists to prevent.
 *
 * Every number here is computed off the curve, not observed. Nothing in this
 * feature has been seen running.
 */
const PART_EASE = [0.25, 0.08, 0.55, 0.3] as const;
/** How far a panel rises before it goes. Larger than the assembly's brick lift:
 *  that one is a piece coming off its studs, this is a release, and it has to
 *  register inside one rise — `liftScheduleForSlot`, 160ms at the beats as
 *  they stand — against a flight that is about to cross the screen. */
const PART_RISE = -18;
/**
 * The tail of the flight over which opacity finally gives out.
 *
 * Short, and at the very end. Fading across the whole flight turns it back
 * into a dissolve — the thing this exit replaced — and not fading at all
 * leaves a hard-edged panel meeting the frame boundary, which reads as a clip
 * rather than as a departure.
 */
const PART_FADE_DURATION = 0.12;

type TransitionState = {
  exiting: boolean;
  reduced: boolean;
  maxOrder: number;
  /** "assemble" is the brick placement, for /pricing arrivals and direct
   *  loads. "resolve" is the time warp's condensation. */
  mode: "assemble" | "resolve";
  /** True once a chrono rewind is under way and the panels should lift and
   *  fly out of the frame. */
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
  // must not be mistaken for the rewind that takes it back out.
  // `!reduced` is not defensive tidiness. Every other branch in this file gates
  // on it, and this one moves six panels a full viewport width sideways —
  // exactly the class of motion the preference exists to suppress. Without it a
  // motion-sensitive visitor gets the largest translation on the whole page.
  // Falling through leaves the page still, and it simply unmounts at the swap.
  const rewinding =
    !reduced &&
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

function usePanelMotionProps(
  order: number,
  /** Which way this panel flies on the way home; see `usePartDirection`. */
  partDir: RefObject<-1 | 1>,
) {
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
      // to resolve is the first to go — but NOT the assembly's EXIT_STAGGER.
      // That constant belongs to a move whose end nothing waits on; this
      // window closes at CHRONO_IN.part[1] and the cover comes up behind it,
      // so the spread is derived from the room the window actually has. The
      // lift takes the same offset, so the two beats stay in step.
      const flight = partScheduleForSlot(order, maxOrder);
      const rise = liftScheduleForSlot(order, maxOrder);
      const flightDelay = flight.startMs / 1000;
      const flightDuration = flight.durationMs / 1000;
      return {
        initial: false,
        animate: {
          y: PART_RISE,
          // Measured after mount, so "away from the centre of the screen" is
          // the layout's own answer rather than an assumption about it.
          //
          // `innerWidth` here on purpose, unlike the `clientWidth` the CENTRE
          // is measured against in `usePartDirection`. This is a travel
          // distance with only a floor to satisfy — far enough to clear the
          // frame — so a scrollbar's 7-8px of over-travel is free, and the
          // panel is long gone by the time it matters. The centre has no such
          // slack: it is compared against a 2px epsilon.
          x: partDir.current * partDistance(window.innerWidth),
          opacity: 0,
        },
        // One target, three clocks. The rise is short and eased OUT so it
        // settles into the flight; the flight is long and accelerates off the
        // edge on PART_EASE; opacity holds through both and only gives
        // out over the last fraction, which is what keeps the panel a solid
        // object leaving rather than a ghost fading sideways.
        transition: {
          y: {
            duration: rise.durationMs / 1000,
            ease: "easeOut",
            delay: rise.startMs / 1000,
          },
          x: { duration: flightDuration, ease: PART_EASE, delay: flightDelay },
          opacity: {
            duration: PART_FADE_DURATION,
            ease: "linear",
            delay: flightDelay + flightDuration - PART_FADE_DURATION,
          },
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
 * Which side of the frame this panel leaves by, measured once after mount.
 *
 * Measured rather than derived from the slot, because the point of the beat is
 * that the two plan cards go the way they already are — Pro left, Lifetime
 * right — and only the layout knows where that is. Once is enough, and this is
 * the one moment it can be read cheaply and correctly:
 *
 *   - Layout is final. A chrono arrival mounts behind a fully opaque stage, so
 *     there is no first paint to beat; and Back cannot be pressed for at least
 *     the length of the outbound arc after that.
 *   - The box is untransformed in the horizontal. This runs before the effect
 *     that switches `mode` to "resolve", so the styles in the DOM are still the
 *     assembly's — a y offset and a scale about the panel's own centre, neither
 *     of which moves a horizontal centre. Reading it one commit later would
 *     measure the resolve smear's ~14px tangent offset instead, which is enough
 *     to push a full-width section off the centre line and out of the parity
 *     fallback below.
 *
 * A ref rather than state on purpose: nothing about this needs to re-render,
 * and the value is only ever read on the exit, hundreds of ms after it is
 * written.
 */
function usePartDirection<T extends HTMLElement>(order: number) {
  const ref = useRef<T | null>(null);
  const direction = useRef<-1 | 1>(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    // `clientWidth`, NOT `innerWidth`. innerWidth includes a space-taking
    // scrollbar (Windows and Linux always; macOS whenever "Show scroll bars" is
    // set to Always), so on those platforms its half is 7-8px right of where a
    // centred `mx-auto` band actually sits. That is four times
    // PART_CENTRED_EPSILON, so every full-width section would measure as
    // left-of-centre and the four of them would leave as one slab — the exact
    // outcome the parity fallback exists to prevent. Invisible on a Mac with
    // overlay scrollbars, which is why it would never surface locally.
    direction.current = partDirection(
      box.left + box.width / 2,
      document.documentElement.clientWidth / 2,
      order,
    );
  }, [order]);
  return { ref, direction };
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
  const { ref, direction } = usePartDirection<HTMLDivElement>(order);
  const motionProps = usePanelMotionProps(order, direction);
  return (
    <motion.div ref={ref} className={className} {...motionProps}>
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
  const { ref, direction } = usePartDirection<HTMLElement>(order);
  const motionProps = usePanelMotionProps(order, direction);
  return (
    <motion.header ref={ref} className={className} {...motionProps}>
      {children}
    </motion.header>
  );
}
