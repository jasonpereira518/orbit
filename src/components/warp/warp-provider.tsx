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
} from "react";
import { createPortal } from "react-dom";
import {
  ARRIVAL_MS,
  ARRIVED_BY_WARP_KEY,
  ASCENT_MS,
  ASCENT_OPAQUE_MS,
  CRUISE_CAP_MS,
  REDUCED_MS,
  REENTRY,
  REENTRY_MS,
} from "@/lib/warp/choreography";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/** The stage is the only heavy part (a canvas loop); it loads on first launch
 * and never on a page that isn't going anywhere. */
const WarpStage = dynamic(
  () => import("@/components/warp/warp-stage").then((m) => ({ default: m.WarpStage })),
  { ssr: false },
);

export type WarpPhase =
  | "idle"
  | "ascending"
  | "cruise"
  | "arriving"
  | "descending"
  | "landing";

export type WarpRun = {
  phase: WarpPhase;
  /** `performance.now()` when this run began. The stage derives every beat
   * from elapsed time rather than from React re-renders. */
  startedAt: number;
  /** When deceleration began, once /pricing has actually painted. */
  arrivingAt: number | null;
  /** Viewport point the launch fired from, for the ignition ring. */
  origin: { x: number; y: number } | null;
  /** Collapses both arcs to a plain cross-fade. */
  reduced: boolean;
};

type WarpApi = {
  run: WarpRun;
  /** Fly to /pricing. `origin` is the clicked element's rect. */
  launch: (origin?: DOMRect | null) => void;
  /**
   * Fall back into the app. Returns false if a run is already in flight, in
   * which case the caller still owes the navigation.
   *
   * Takes the navigation rather than performing it, so it composes with
   * `BackControl`'s `onBeforeNavigate` contract — that seam already handles
   * the no-history case by pushing home instead of going back.
   */
  reenter: (navigate?: () => void) => boolean;
  /** Called by the arrival beacon once /pricing has mounted. */
  arrive: () => void;
};

/** The only place a lift-off ever goes. */
const WARP_DESTINATION = "/pricing";

const IDLE: WarpRun = {
  phase: "idle",
  startedAt: 0,
  arrivingAt: null,
  origin: null,
  reduced: false,
};

const WarpContext = createContext<WarpApi | null>(null);

export function useWarp() {
  const ctx = useContext(WarpContext);
  if (!ctx) {
    throw new Error("useWarp must be used inside <WarpProvider>");
  }
  return ctx;
}

/**
 * True when this visitor is standing exactly where a lift-off dropped them.
 *
 * Scoped to the destination path, not a bare boolean: `BackControl` is also on
 * /upgrade and on every marketing doc, all of which are reachable from /pricing.
 * A boolean flag would fire a fall-to-Earth on /upgrade -> /pricing — a descent
 * that lands you back in space, which reads as a glitch rather than a journey.
 */
export function arrivedByWarp() {
  if (typeof window === "undefined") return false;
  try {
    const from = window.sessionStorage.getItem(ARRIVED_BY_WARP_KEY);
    return from !== null && from === window.location.pathname;
  } catch {
    // Safari private mode throws on sessionStorage. Falling back to "no warp"
    // costs a nicety, never a navigation.
    return false;
  }
}

function setArrivedByWarp(destination: string | null) {
  try {
    if (destination) window.sessionStorage.setItem(ARRIVED_BY_WARP_KEY, destination);
    else window.sessionStorage.removeItem(ARRIVED_BY_WARP_KEY);
  } catch {
    /* see arrivedByWarp */
  }
}

/**
 * Owns the journey between the app and /pricing.
 *
 * Mounted in the ROOT layout, above both route groups. `/dashboard` is in
 * `(app)` and `/pricing` is in `(marketing)`, so navigating between them
 * unmounts an entire layout subtree — anything that has to survive mid-flight
 * cannot live inside either one.
 */
export function WarpProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const reduced = usePrefersReducedMotion();
  const [run, setRun] = useState<WarpRun>(IDLE);

  // Every pending timer for the current run, cleared together on reset so a
  // second launch can never be stepped on by the first one's tail.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // /pricing may paint before the ascent finishes; remember that we can go
  // straight to deceleration instead of holding in cruise.
  const pageReady = useRef(false);
  const phaseRef = useRef<WarpPhase>("idle");
  // Skipping before the route has swapped would arrive at a page that was never
  // asked for, so the skip has to be able to force the push forward.
  const pushedRef = useRef(false);

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
    if (phaseRef.current !== "ascending" && phaseRef.current !== "cruise") return;
    phaseRef.current = "arriving";
    setRun((r) => ({ ...r, phase: "arriving", arrivingAt: performance.now() }));
    after(reduced ? REDUCED_MS : ARRIVAL_MS, settle);
  }, [after, reduced, settle]);

  const launch = useCallback(
    (origin?: DOMRect | null) => {
      if (phaseRef.current !== "idle") return;
      clearTimers();
      pageReady.current = false;
      pushedRef.current = false;
      phaseRef.current = "ascending";
      setArrivedByWarp(WARP_DESTINATION);

      setRun({
        phase: "ascending",
        startedAt: performance.now(),
        arrivingAt: null,
        origin: origin
          ? { x: origin.left + origin.width / 2, y: origin.top + origin.height / 2 }
          : null,
        reduced,
      });

      // Swap the route only once the sky covers the frame. Earlier than this
      // and the `(app)` layout — which owns the element visibly flying away —
      // unmounts mid-flight.
      after(reduced ? REDUCED_MS : ASCENT_OPAQUE_MS, () => {
        if (pushedRef.current) return;
        pushedRef.current = true;
        router.push(WARP_DESTINATION);
      });

      // End of the deterministic climb: decelerate if /pricing is already up,
      // otherwise hold in cruise until the beacon fires.
      after(reduced ? REDUCED_MS : ASCENT_MS, () => {
        if (phaseRef.current !== "ascending") return;
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

  /**
   * Cut the journey short and land now.
   *
   * Seven seconds is a long time to hold somebody who has seen it before, so
   * any key or pointer press ends it. The navigation is not abandoned — if the
   * push has not fired yet it is brought forward, because arriving early at the
   * page you were still standing on would be worse than the wait.
   */
  const skip = useCallback(() => {
    if (phaseRef.current !== "ascending" && phaseRef.current !== "cruise") return;
    if (!pushedRef.current) {
      pushedRef.current = true;
      router.push(WARP_DESTINATION);
    }
    beginArrival();
  }, [beginArrival, router]);

  const arrive = useCallback(() => {
    pageReady.current = true;
    if (phaseRef.current === "cruise") beginArrival();
  }, [beginArrival]);

  const reenter = useCallback((navigate?: () => void) => {
    if (phaseRef.current !== "idle") return false;
    clearTimers();
    phaseRef.current = "descending";
    setArrivedByWarp(null);
    setRun({
      phase: "descending",
      startedAt: performance.now(),
      arrivingAt: null,
      origin: null,
      reduced,
    });
    // Navigate immediately: unlike the ascent there is nothing on screen worth
    // preserving, and the app needs to be mounted before the touchdown judder.
    if (navigate) navigate();
    else router.back();
    if (!reduced) {
      // The judder has to fire on a timer, not on mount: `(app)` remounts at
      // whatever pace the router resolves, and a shake nobody sees (because
      // the stage is still opaque over it) is a shake that did not happen.
      after(REENTRY.judder[0], () => {
        if (phaseRef.current !== "descending") return;
        phaseRef.current = "landing";
        setRun((r) => ({ ...r, phase: "landing" }));
      });
    }
    after(reduced ? REDUCED_MS : REENTRY_MS, settle);
    return true;
  }, [after, clearTimers, reduced, router, settle]);

  // Any input ends the trip early. Deliberately not just Escape: somebody who
  // wants out reaches for whatever is nearest, and on a touch screen there is
  // no Escape at all.
  useEffect(() => {
    if (run.phase !== "ascending" && run.phase !== "cruise") return;
    // The click that launched can still be delivering its own pointerup/click,
    // and a launch that cancels itself on the way up is not a feature.
    const armAt = run.startedAt + 500;
    const onInput = () => {
      if (performance.now() >= armAt) skip();
    };
    window.addEventListener("keydown", onInput);
    window.addEventListener("pointerdown", onInput);
    return () => {
      window.removeEventListener("keydown", onInput);
      window.removeEventListener("pointerdown", onInput);
    };
  }, [run.phase, run.startedAt, skip]);

  // Drives the craft animation and the scroll lock from CSS. Set on <html> so
  // the selector can reach `[data-warp-craft]` in whichever layout is mounted.
  useEffect(() => {
    const el = document.documentElement;
    if (run.phase === "idle") el.removeAttribute("data-warp");
    else el.setAttribute("data-warp", run.reduced ? "reduced" : run.phase);
    return () => el.removeAttribute("data-warp");
  }, [run.phase, run.reduced]);

  useEffect(() => clearTimers, [clearTimers]);

  const api = useMemo<WarpApi>(
    () => ({ run, launch, reenter, arrive }),
    [run, launch, reenter, arrive],
  );

  return (
    <WarpContext.Provider value={api}>
      {children}
      {/* Phase only leaves "idle" via a click, so this is unreachable during
          SSR and on the hydrating render — `document` is always there by the
          time the expression is evaluated. */}
      {run.phase !== "idle" && createPortal(<WarpStage run={run} />, document.body)}
    </WarpContext.Provider>
  );
}
