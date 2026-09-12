"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { createPortal } from "react-dom";
import {
  ARRIVED_BY_WARP_KEY,
  CRUISE_CAP_MS,
  REDUCED_MS,
} from "@/lib/warp/choreography";
import {
  JOURNEYS,
  decodeArrival,
  encodeArrival,
  type JourneyId,
} from "@/lib/warp/journeys";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * How long the stage stays up after `skip()` navigates, so the route swap has
 * time to resolve behind cover instead of exposing the pre-navigation page for
 * a frame.
 *
 * Enough on its own only where the stage is already opaque when skip lands.
 * On liftoff's return that holds: the canvas sits at full cover until the
 * judder begins, so this window just keeps it there. On chrono's way home it
 * does not — the cover there is at 0 until `CHRONO_IN_COVER` opens (see
 * chrono.ts), and holding a TRANSPARENT canvas up for 120ms hides nothing.
 * That leg needs the pin; see `WarpRun.covered`.
 */
const SKIP_COVER_MS = 120;

export type WarpPhase =
  | "idle"
  | "outbound"
  | "cruise"
  | "arriving"
  | "inbound"
  | "landing";

export type WarpRun = {
  /** Which journey is flying. Selects the stage and every duration. */
  journey: JourneyId;
  phase: WarpPhase;
  /** `performance.now()` when this run began. Stages derive every beat from
   *  elapsed time rather than from React re-renders. */
  startedAt: number;
  /** When deceleration began, once the destination has actually painted. */
  arrivingAt: number | null;
  /** Viewport point the launch fired from, for the ignition ring. */
  origin: { x: number; y: number } | null;
  /** Collapses every arc to a plain cross-fade. */
  reduced: boolean;
  /**
   * Set by `skip()` when it brings a chrono rewind's route swap forward.
   *
   * The stage must pin itself fully opaque for the rest of the run when this
   * is true. `SKIP_COVER_MS` was written when the inbound cover was opaque
   * from frame one, so bringing the navigation forward was safe on its own;
   * it no longer is — the cover now stays at 0 until `CHRONO_IN_COVER` opens
   * so the panels can be seen leaving, and a skip at t=150 would otherwise
   * swap the route with no cover at all: panels frozen mid-flight, hard cut
   * to the origin page.
   * Forcing the cover rather than deferring the navigation on purpose —
   * "stop waiting" is the entire point of skip, and a delayed button reads as
   * a broken one.
   */
  covered: boolean;
};

type WarpApi = {
  run: WarpRun;
  /** Fly `journey`. `origin` is the clicked element's rect. */
  launch: (journey: JourneyId, origin?: DOMRect | null) => void;
  /** Reverse whichever journey delivered you. False if there was none, or if
   *  a run is already in flight. */
  reenter: () => boolean;
  /** Finish the current run now: navigate if that has not happened yet, then
   *  settle. The escape hatch for an arc somebody has stopped wanting. */
  skip: () => void;
  /** Called by the arrival beacon once the destination has mounted. */
  arrive: () => void;
};

/** Stages are the only heavy part (a canvas loop each). Loaded per journey, so
 *  the chrono canvas never enters the bundle for someone who only ever
 *  launches the rocket. */
const STAGES: Record<JourneyId, ComponentType<{ run: WarpRun }>> = {
  liftoff: dynamic(
    () =>
      import("@/components/warp/liftoff-stage").then((m) => ({
        default: m.LiftoffStage,
      })),
    { ssr: false },
  ),
  chrono: dynamic(
    () =>
      import("@/components/warp/chrono-stage").then((m) => ({
        default: m.ChronoStage,
      })),
    { ssr: false },
  ),
};

const IDLE: WarpRun = {
  journey: "liftoff",
  phase: "idle",
  startedAt: 0,
  arrivingAt: null,
  origin: null,
  reduced: false,
  covered: false,
};

const WarpContext = createContext<WarpApi | null>(null);

export function useWarp() {
  const ctx = useContext(WarpContext);
  if (!ctx) throw new Error("useWarp must be used inside <WarpProvider>");
  return ctx;
}

/**
 * Which journey — if any — dropped this visitor exactly where they stand.
 *
 * Scoped to the journey AND the destination path, not a bare boolean:
 * `BackControl` is on /pricing, on /upgrade and on every marketing doc, all of
 * which are reachable from each other. A boolean would fire a fall-to-Earth on
 * /upgrade after a /pricing -> /upgrade step — a descent that lands you back
 * in space, which reads as a glitch rather than as a journey.
 */
export function arrivedBy(): JourneyId | null {
  if (typeof window === "undefined") return null;
  try {
    return decodeArrival(
      window.sessionStorage.getItem(ARRIVED_BY_WARP_KEY),
      window.location.pathname,
    );
  } catch {
    // Safari private mode throws on sessionStorage. Falling back to "no
    // journey" costs a nicety, never a navigation.
    return null;
  }
}

function setArrival(value: string | null) {
  try {
    if (value) window.sessionStorage.setItem(ARRIVED_BY_WARP_KEY, value);
    else window.sessionStorage.removeItem(ARRIVED_BY_WARP_KEY);
  } catch {
    /* see arrivedBy */
  }
}

/**
 * Owns both journeys between the app and the marketing world.
 *
 * Mounted in the ROOT layout, above every route group: `/dashboard` is in
 * `(app)`, `/pricing` in `(marketing)` and `/upgrade` in `(checkout)`, so
 * navigating between them unmounts an entire layout subtree. Anything that has
 * to survive mid-flight cannot live inside one.
 *
 * One phase machine serves both journeys, which is what makes them mutually
 * exclusive by construction — Settings offers a rocket and a time warp as
 * adjacent buttons, and two full-screen stages must never race.
 */
export function WarpProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const reduced = usePrefersReducedMotion();
  const [run, setRun] = useState<WarpRun>(IDLE);

  // Every pending timer for the current run, cleared together on reset so a
  // second launch can never be stepped on by the first one's tail.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // The destination may paint before the outbound run finishes; remember that
  // we can go straight to deceleration instead of holding in cruise.
  const pageReady = useRef(false);
  const phaseRef = useRef<WarpPhase>("idle");
  const journeyRef = useRef<JourneyId>("liftoff");
  // The route swap happens on a timer, and `skip()` may need to bring it
  // forward. Either way it must happen exactly once.
  const navigated = useRef(false);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);

  const after = useCallback((ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  const settle = useCallback(() => {
    clearTimers();
    pageReady.current = false;
    phaseRef.current = "idle";
    setRun(IDLE);
  }, [clearTimers]);

  const beginArrival = useCallback(() => {
    if (phaseRef.current !== "outbound" && phaseRef.current !== "cruise") return;
    phaseRef.current = "arriving";
    setRun((r) => ({ ...r, phase: "arriving", arrivingAt: performance.now() }));
    after(
      reduced ? REDUCED_MS : JOURNEYS[journeyRef.current].beats.arrivingMs,
      settle,
    );
  }, [after, reduced, settle]);

  const launch = useCallback(
    (id: JourneyId, origin?: DOMRect | null) => {
      if (phaseRef.current !== "idle") return;
      const journey = JOURNEYS[id];
      clearTimers();
      pageReady.current = false;
      navigated.current = false;
      phaseRef.current = "outbound";
      journeyRef.current = id;
      setArrival(encodeArrival(id, journey.destination));

      setRun({
        journey: id,
        phase: "outbound",
        startedAt: performance.now(),
        arrivingAt: null,
        origin: origin
          ? { x: origin.left + origin.width / 2, y: origin.top + origin.height / 2 }
          : null,
        reduced,
        covered: false,
      });

      // Swap the route only once the stage covers the frame. Earlier than this
      // and the layout owning `[data-warp-craft]` — the element visibly leaving
      // — unmounts mid-flight.
      after(reduced ? REDUCED_MS : journey.beats.opaqueMs, () => {
        if (navigated.current) return;
        navigated.current = true;
        router.push(journey.destination);
      });

      // End of the deterministic run: decelerate if the destination is already
      // up, otherwise hold in cruise until the beacon fires.
      after(reduced ? REDUCED_MS : journey.beats.outboundMs, () => {
        if (phaseRef.current !== "outbound") return;
        if (pageReady.current) {
          beginArrival();
          return;
        }
        phaseRef.current = "cruise";
        setRun((r) => ({ ...r, phase: "cruise" }));
      });

      // A route that never resolves must not strand anyone on a black screen.
      after(CRUISE_CAP_MS, beginArrival);
    },
    [after, beginArrival, clearTimers, reduced, router],
  );

  const arrive = useCallback(() => {
    pageReady.current = true;
    if (phaseRef.current === "cruise") beginArrival();
  }, [beginArrival]);

  const reenter = useCallback(() => {
    if (phaseRef.current !== "idle") return false;
    const id = arrivedBy();
    if (!id) return false;
    const journey = JOURNEYS[id];

    clearTimers();
    navigated.current = false;
    phaseRef.current = "inbound";
    journeyRef.current = id;
    setArrival(null);
    setRun({
      journey: id,
      phase: "inbound",
      startedAt: performance.now(),
      arrivingAt: null,
      origin: null,
      reduced,
      covered: false,
    });

    const goBack = () => {
      if (navigated.current) return;
      navigated.current = true;
      router.back();
    };
    if (reduced || journey.beats.inboundPushMs === 0) goBack();
    else after(journey.beats.inboundPushMs, goBack);

    if (!reduced) {
      // The touchdown has to fire on a timer, not on mount: the destination
      // layout remounts at whatever pace the router resolves, and a beat
      // nobody sees — because the stage is still opaque over it — is a beat
      // that did not happen.
      after(journey.beats.inboundLandingMs, () => {
        if (phaseRef.current !== "inbound") return;
        phaseRef.current = "landing";
        setRun((r) => ({ ...r, phase: "landing" }));
      });
    }
    after(reduced ? REDUCED_MS : journey.beats.inboundMs, settle);
    return true;
  }, [after, clearTimers, reduced, router, settle]);

  const skip = useCallback(() => {
    const phase = phaseRef.current;
    if (phase === "idle") return;
    const journey = JOURNEYS[journeyRef.current];
    const homeward = phase === "inbound" || phase === "landing";
    clearTimers();
    // Raise the cover BEFORE the swap, not after it. On the chrono way home
    // the stage is deliberately transparent until CHRONO_IN_COVER opens, so
    // the panels can be seen leaving; a skip at t=150 would otherwise swap the
    // route through a clear canvas.
    //
    // Ordering, stated honestly: this does NOT commit atomically with the
    // navigation. The pin travels state -> render -> the stage's `runRef` sync
    // effect -> the next rAF frame, so it lands about a frame from here. What
    // it beats is `router.back()`, which only calls `history.back()`: the
    // popstate arrives in a later task and the destination's own render and
    // paint are later still. Setting it first is what buys that margin, and it
    // is the whole margin available without the provider reaching across into
    // the stage's canvas directly.
    //
    // Scoped to that one leg, which is also the only leg skip() can be reached
    // on today: BackControl ignores a press during a chrono outbound and
    // Escape routes "cruise" to beginArrival() instead. The gate is therefore
    // belt-and-braces for a future caller, and it is the right shape for one —
    // chrono's outbound cover ramps across its first 560ms and a pin would cut
    // that ramp off, while liftoff's arcs are already at full cover and need
    // nothing. Reduced motion is excluded because the pin sits ABOVE the
    // reduced branch in `coverage()`: it would replace that path's fade with a
    // hard cut to an opaque full-viewport canvas, which is the luminance jump
    // the preference is asking to avoid.
    if (homeward && journeyRef.current === "chrono" && !run.reduced) {
      setRun((r) => (r.covered ? r : { ...r, covered: true }));
    }
    if (!navigated.current) {
      navigated.current = true;
      if (homeward) router.back();
      else router.push(journey.destination);
    }
    // Stay covering the frame a beat longer: settling in the same tick as the
    // navigation would unmount the stage before the route swap resolves,
    // flashing whatever page is still underneath.
    after(SKIP_COVER_MS, settle);
  }, [after, clearTimers, router, run.reduced, settle]);

  // Escape completes a journey rather than abandoning it — the navigation is
  // already in flight, so the only thing left to skip is the waiting.
  //
  // Scoped to chrono on the way home: the rocket's 750ms fall is short enough
  // that nobody is waiting on it, and leaving it alone keeps this refactor
  // observably invisible to the lift-off.
  useEffect(() => {
    if (run.phase === "idle") return;
    const onKey = (e: KeyboardEvent) => {
      // `repeat` matters: holding Escape down through a rewind would re-arm
      // skip()'s cover timer on every auto-repeat, keeping the app shell
      // covered — and unclickable — until the key came back up.
      if (e.key !== "Escape" || e.repeat) return;
      const phase = phaseRef.current;
      if (phase === "cruise") beginArrival();
      else if (
        journeyRef.current === "chrono" &&
        (phase === "inbound" || phase === "landing")
      ) {
        skip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run.phase, beginArrival, skip]);

  // Drives the departure animation and the scroll lock from CSS. Set on <html>
  // so the selectors can reach `[data-warp-craft]` in whichever layout is
  // mounted. The journey rides alongside the phase: both journeys share the
  // craft element, so the liftoff rules must not fire on a chrono departure.
  useEffect(() => {
    const el = document.documentElement;
    if (run.phase === "idle") {
      el.removeAttribute("data-warp");
      el.removeAttribute("data-warp-journey");
    } else {
      el.setAttribute("data-warp", run.reduced ? "reduced" : run.phase);
      el.setAttribute("data-warp-journey", run.journey);
    }
    return () => {
      el.removeAttribute("data-warp");
      el.removeAttribute("data-warp-journey");
    };
  }, [run.phase, run.reduced, run.journey]);

  useEffect(() => clearTimers, [clearTimers]);

  const api = useMemo<WarpApi>(
    () => ({ run, launch, reenter, skip, arrive }),
    [run, launch, reenter, skip, arrive],
  );

  const Stage = STAGES[run.journey];

  return (
    <WarpContext.Provider value={api}>
      {children}
      {/* Phase only leaves "idle" via a click, so this is unreachable during
          SSR and on the hydrating render — `document` is always there by the
          time the expression is evaluated. */}
      {run.phase !== "idle" && createPortal(<Stage run={run} />, document.body)}
    </WarpContext.Provider>
  );
}
