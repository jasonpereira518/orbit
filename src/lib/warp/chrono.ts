/**
 * The chrono journey: Settings -> /upgrade, told as a long exposure.
 * Beat tables and the pure per-frame math. See the design spec for why each
 * window is where it is.
 */

/**
 * When the stage covers the frame and the route swap becomes invisible.
 *
 * This one constant is load-bearing at THREE separate sync points, not one —
 * retuning it means checking all three:
 *   1. `CHRONO_OUT.shutter[1]` is defined in terms of it below, so the
 *      departure cover always finishes exactly here. If it didn't, the route
 *      swap would happen while the stage is still translucent: a white flash.
 *   2. `coverage()` in chrono-stage.tsx uses it as the start of the arriving
 *      window's hold-then-handoff ramp — the opacity stays pinned to fully
 *      covered until the collapse below has had time to finish.
 *   3. `chronoFrame`'s `"arriving"` branch uses it as the collapse's own
 *      duration, so the spin-down and shutter-close motion is guaranteed to
 *      finish before `coverage()` starts revealing the real page underneath.
 * Point 1 is now structural (a derived value can't drift). Points 2 and 3 are
 * still trusting call sites to import the constant rather than a literal —
 * grep for `CHRONO_OPAQUE_MS` after touching either file.
 */
export const CHRONO_OPAQUE_MS = 560;
/** End of the deterministic outbound run, before any cruise hold. */
export const CHRONO_OUTBOUND_MS = 1950;
/** Deceleration: arcs collapse back into stars. The payoff shot. */
export const CHRONO_ARRIVING_MS = 860;
/** The rewind home, start to settled. */
export const CHRONO_INBOUND_MS = 1900;

import {
  CRUISE_CAP_MS,
  easeHouse,
  easeIn,
  lerp,
  span,
} from "@/lib/warp/choreography";

/** Outbound beats, ms from launch. */
export const CHRONO_OUT = {
  /** The room goes dark and the stage covers the frame. Derived from
   *  CHRONO_OPAQUE_MS rather than a duplicated literal — see the comment
   *  there for why the two must never diverge. */
  shutter: [0, CHRONO_OPAQUE_MS],
  /** Time accelerates: the spin ramps up and the shutter opens. */
  spin: [420, 1700],
  /** The orbit grows. */
  growth: [560, 1850],
} as const;

/** Inbound beats, ms from the moment Back is pressed. */
export const CHRONO_IN = {
  /** Panels smear back into the exposure. */
  dissolve: [0, 380],
  /** Late, unlike the rocket's frame-one push: the page dissolving is the shot. */
  push: 340,
  /** Time runs backwards. */
  rewind: [240, 1200],
  /** Stars go out in bursts; the growth un-happens. */
  extinguish: [400, 1300],
  /** Arcs collapse back to points. */
  collapse: [1250, 1700],
  /** The room lights come back up. */
  landing: [1550, 1900],
} as const;

/**
 * When the stage covers the frame on the way home, ms from Back.
 *
 * The cover ramps UP across the dissolve rather than being opaque from frame
 * one — the panels smearing back into the exposure is the shot, and a stage
 * that is already opaque hides it completely. But it has to be complete before
 * `push` swaps the route, or the swap itself shows through a translucent
 * canvas. Derived from both beats so retuning either one cannot open a gap.
 */
export const CHRONO_IN_COVER = [
  CHRONO_IN.dissolve[0],
  Math.min(CHRONO_IN.dissolve[1], CHRONO_IN.push),
] as const;

/**
 * The page resolving out of the exposure, in ms.
 *
 * These are panel timings, and they live here rather than in
 * `upgrade-transition.tsx` because they have to interlock with the reveal —
 * the window where `coverage()` lifts the stage off the page, which runs from
 * CHRONO_OPAQUE_MS to CHRONO_ARRIVING_MS after deceleration begins. The whole
 * point of this arrival is that the sharpening happens INSIDE that window: a
 * page that finishes resolving before the veil lifts is "sky cleared, then
 * page faded in", which is the thing this journey exists not to be. That
 * invariant is only checkable if both halves are in one table, so they are.
 */
export const CHRONO_RESOLVE = {
  /** After deceleration begins, when the FIRST panel starts sharpening.
   *  Deliberately a little before the reveal opens, so it is already mid-blur
   *  when the veil lifts instead of starting from scratch in clear sky. */
  lead: CHRONO_OPAQUE_MS - 100,
  /** Between panels. Shorter than the assembly's: these are condensing out of
   *  one exposure, not being placed one at a time. */
  stagger: 45,
  /** One panel, smeared to sharp. */
  duration: 260,
} as const;

/**
 * The celestial pole, as viewport fractions. On-screen and high to one side:
 * the concentric sweep around a visible pole is the image people decode as
 * "hours passed". The innermost radii are thinned by the stage so this never
 * becomes a bullseye competing with the arriving page.
 */
export const POLE = { x: 0.22, y: 0.16 } as const;

/**
 * The shutter. How much of the trail layer each frame erases: 1 leaves no
 * trail at all, low values leave long arcs. Trail length is entirely this
 * number, which is why acceleration and deceleration cost one lerp each.
 */
export const ALPHA_STILL = 0.55;
export const ALPHA_FAST = 0.045;

/** Peak angular velocity, radians per second. */
export const OMEGA_PEAK = 1.9;

/**
 * Where the seven ignition bursts land inside the growth window, as fractions.
 * Deliberately uneven — an even cadence reads as a progress bar rather than as
 * a network gaining people. Pinned by the smoke script.
 */
export const IGNITION_FRACTIONS = [0, 0.13, 0.31, 0.4, 0.62, 0.79, 1] as const;

/** During a cruise hold, one further burst every this many ms, so a slow route
 *  still reads as growth instead of as a loop. */
export const CRUISE_BURST_MS = 420;

/**
 * How many further bursts a hold can fire before the reserve runs out.
 *
 * A counter that keeps incrementing past the last star that can answer it is
 * not growth, it is arithmetic: the stage seeds exactly this many reserve
 * burst levels, and `chronoFrame` must not promise more than that.
 *
 * Derived from the longest hold that can actually happen — `CRUISE_CAP_MS` is
 * measured from launch, so the hold itself cannot outlast
 * CRUISE_CAP_MS - CHRONO_OUTBOUND_MS. Floor rather than ceiling on purpose: a
 * level beyond that is one no hold can ever reach, and the stars seeded into
 * it would sit in the field forever without lighting. A hold that overshoots
 * (a main thread too busy to run the cap's timer on time) is absorbed by the
 * clamp in `cruiseBurstsBy` instead.
 */
export const CRUISE_BURSTS = Math.floor(
  (CRUISE_CAP_MS - CHRONO_OUTBOUND_MS) / CRUISE_BURST_MS,
);

/**
 * How much extra field the stage holds back for those bursts, as a fraction of
 * the base star count.
 *
 * The seven scripted bursts spend ~12% of the field each; at that rate a
 * full-length hold would roughly double the sky and overfill the frame right
 * where the payment form is about to land. A fifth of the field spread across
 * the whole reserve is a steady trickle — visible new stars every 420ms —
 * that still leaves the arrival composition recognisably the one that was
 * designed. Reserve stars are drawn from the whole radius range rather than
 * continuing the outward march: they are the sky filling in during a wait,
 * not part of the seven-burst spread.
 */
export const CRUISE_RESERVE_FRACTION = 0.2;

/**
 * Which ignition burst lights a star at this radius rank — 0 nearest the pole,
 * 1 farthest. Growth spreads OUTWARD: a few spots near the pole, then the sky
 * filling out to the frame edges, rather than stars pricking on at random all
 * over at once.
 */
export function burstForRadiusRank(rank: number) {
  const i = Math.floor(rank * IGNITION_FRACTIONS.length);
  return Math.min(IGNITION_FRACTIONS.length - 1, Math.max(0, i));
}

export type ChronoPhase = "outbound" | "cruise" | "arriving" | "inbound";

export type ChronoFrame = {
  /** Radians per second. Negative on the way home. */
  omega: number;
  /** The shutter; see ALPHA_STILL. */
  alpha: number;
  /** How many ignition bursts have fired. */
  bursts: number;
  /** Fraction of the grown field still lit. 1 outbound, falling to 0 on the
   *  way home as the growth un-happens. */
  alive: number;
};

/**
 * How many bursts a hold of `elapsed` total run time has added on top of the
 * scripted seven. Clamped to the reserve the stage actually seeded.
 */
function cruiseBurstsBy(elapsed: number) {
  const held = Math.max(0, elapsed - CHRONO_OUTBOUND_MS);
  return Math.min(CRUISE_BURSTS, Math.floor(held / CRUISE_BURST_MS));
}

function burstsBy(elapsed: number) {
  const [from, to] = CHRONO_OUT.growth;
  let n = 0;
  for (const f of IGNITION_FRACTIONS) {
    if (elapsed >= lerp(from, to, f)) n += 1;
  }
  return n;
}

/**
 * Every beat as a pure function of elapsed time.
 *
 * `elapsed` is ms since the run began; `sinceArriving` is ms since
 * deceleration started, and is only read in the "arriving" phase. Nothing here
 * touches the DOM, which is what makes the whole arc testable.
 */
export function chronoFrame(
  phase: ChronoPhase,
  elapsed: number,
  sinceArriving: number
): ChronoFrame {
  if (phase === "arriving") {
    // Collapse fills the first 560ms of the arriving window (the shutter
    // length — CHRONO_OPAQUE_MS); the rest is the cross-fade into the real
    // starfield.
    const p = easeHouse(span(sinceArriving, [0, CHRONO_OPAQUE_MS]));
    return {
      omega: OMEGA_PEAK * (1 - p),
      alpha: lerp(ALPHA_FAST, 1, p),
      // Frozen at whatever the hold had reached: `elapsed - sinceArriving` is
      // the elapsed time at the instant deceleration began. Reporting a bare
      // seven here would snuff out every star a cruise hold had just lit, at
      // exactly the moment the sky is being handed to the page.
      bursts: IGNITION_FRACTIONS.length + cruiseBurstsBy(elapsed - sinceArriving),
      alive: 1,
    };
  }

  if (phase === "inbound") {
    const rise = easeIn(span(elapsed, CHRONO_IN.rewind));
    const fall = easeHouse(span(elapsed, CHRONO_IN.collapse));
    const opened = lerp(ALPHA_STILL, ALPHA_FAST, rise);
    return {
      // Negative: time runs the other way. `fall` brings it back to rest.
      omega: -OMEGA_PEAK * rise * (1 - fall),
      alpha: lerp(opened, 1, fall),
      bursts: IGNITION_FRACTIONS.length,
      alive: 1 - span(elapsed, CHRONO_IN.extinguish),
    };
  }

  if (phase === "cruise") {
    return {
      omega: OMEGA_PEAK,
      alpha: ALPHA_FAST,
      bursts: IGNITION_FRACTIONS.length + cruiseBurstsBy(elapsed),
      alive: 1,
    };
  }

  // Outbound. Accelerating, so the spin eases IN — it reads as time running
  // away rather than as a dial being turned.
  const t = easeIn(span(elapsed, CHRONO_OUT.spin));
  return {
    omega: OMEGA_PEAK * t,
    alpha: lerp(ALPHA_STILL, ALPHA_FAST, t),
    bursts: burstsBy(elapsed),
    alive: 1,
  };
}

/**
 * The direction a panel in assembly slot `order` was smeared by the exposure:
 * the unit tangent of the arc it sits on, i.e. perpendicular to its radius
 * from the pole.
 *
 * Derived from the slot rather than measured from the DOM. Panels stack down
 * the page from a pole that is up and to the left, so the radius angle sweeps
 * predictably; a layout read per panel would buy an accuracy nobody can see
 * and would have to happen before first paint to avoid a flash.
 */
export function tangentForSlot(order: number, maxOrder: number) {
  const t = maxOrder > 0 ? order / maxOrder : 0;
  // Radius angle from the pole to the panel, sweeping as slots descend.
  const radius = lerp(-0.35, 0.96, t);
  const tangent = radius + Math.PI / 2;
  return { x: Math.cos(tangent), y: Math.sin(tangent) };
}
