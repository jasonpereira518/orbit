/**
 * The chrono journey: Settings -> /upgrade, told as a long exposure.
 * Beat tables and the pure per-frame math. See the design spec for why each
 * window is where it is.
 */

/** When the stage covers the frame and the route swap becomes invisible. */
export const CHRONO_OPAQUE_MS = 380;
/** End of the deterministic outbound run, before any cruise hold. */
export const CHRONO_OUTBOUND_MS = 1450;
/** Deceleration: arcs collapse back into stars. The payoff shot. */
export const CHRONO_ARRIVING_MS = 620;
/** The rewind home, start to settled. */
export const CHRONO_INBOUND_MS = 1500;

import { easeHouse, easeIn, lerp, span } from "@/lib/warp/choreography";

/** Outbound beats, ms from launch. */
export const CHRONO_OUT = {
  /** The room goes dark and the stage covers the frame. */
  shutter: [0, 380],
  /** Time accelerates: the spin ramps up and the shutter opens. */
  spin: [300, 1250],
  /** The orbit grows. */
  growth: [520, 1400],
} as const;

/** Inbound beats, ms from the moment Back is pressed. */
export const CHRONO_IN = {
  /** Panels smear back into the exposure. */
  dissolve: [0, 300],
  /** Late, unlike the rocket's frame-one push: the page dissolving is the shot. */
  push: 260,
  /** Time runs backwards. */
  rewind: [200, 950],
  /** Stars go out in bursts; the growth un-happens. */
  extinguish: [350, 1050],
  /** Arcs collapse back to points. */
  collapse: [1050, 1400],
  /** The room lights come back up. */
  landing: [1250, 1500],
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
    // Collapse fills the first 380ms of the arriving window; the rest is the
    // cross-fade into the real starfield.
    const p = easeHouse(span(sinceArriving, [0, 380]));
    return {
      omega: OMEGA_PEAK * (1 - p),
      alpha: lerp(ALPHA_FAST, 1, p),
      bursts: IGNITION_FRACTIONS.length,
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
    const held = Math.max(0, elapsed - CHRONO_OUTBOUND_MS);
    return {
      omega: OMEGA_PEAK,
      alpha: ALPHA_FAST,
      bursts: IGNITION_FRACTIONS.length + Math.floor(held / CRUISE_BURST_MS),
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
