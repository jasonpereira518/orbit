/**
 * Timing for the app <-> /pricing journey.
 *
 * Every number here is duplicated in `globals.css` as a keyframe percentage or
 * duration — the canvas stage and the CSS craft animation have to agree frame
 * for frame or the dashboard is still visibly falling when the sky has already
 * gone black. Treat this file as the source and the CSS as the mirror; the
 * comments in `globals.css` point back here.
 *
 * Two deliberately asymmetric arcs:
 *   ASCENT  — leaving the app for /pricing. Slow, earned, triumphant.
 *   REENTRY — coming back. Fast and bumpy; you fall home rather than fly.
 * The back button is an escape hatch, so re-entry is ~3x shorter than ascent.
 */

/** Milliseconds from launch to the cruise hold. Deterministic.
 *
 * Long on purpose: this is a trip from the ground to deep space, and every
 * band below needs room to be read as a place rather than a colour. Anything
 * under ~3s turns the whole climb into one blue-to-black smear. */
export const ASCENT_MS = 3800;

/**
 * When the stage is fully opaque and the route swap becomes invisible.
 *
 * The push cannot happen at t=0: navigating unmounts the whole `(app)` layout,
 * which takes `[data-warp-craft]` — the element visibly flying away — with it.
 * So we wait until the atmosphere covers the frame, then swap behind it.
 */
export const ASCENT_OPAQUE_MS = 1050;

/** Deceleration + handoff to the real starfield, once /pricing has painted. */
export const ARRIVAL_MS = 500;

/**
 * Hard ceiling on the cruise hold. A route that never resolves must not strand
 * anyone on a black screen, so the stage force-resolves regardless.
 */
export const CRUISE_CAP_MS = 6000;

/** The fall home, start to settled. Still a quarter of the climb: you fall
 * back to Earth, you don't tour it. */
export const REENTRY_MS = 900;

/**
 * Ascent beats, in ms from launch. Heavily overlapped on purpose: each band
 * is already arriving while the one before it is still leaving, which is what
 * makes the climb continuous instead of a slideshow of five separate scenes.
 */
export const ASCENT = {
  /** Engines light; the dashboard judders but has not moved yet. */
  ignition: [0, 250],
  /** The dashboard drops away beneath the camera. */
  liftoff: [200, 1150],
  /** Cloud deck, rushing down past us. */
  troposphere: [300, 1700],
  /** Sky goes navy, the air thins, another rocket races ahead. */
  stratosphere: [1150, 2450],
  /** Earth's limb below, satellites drifting up past the camera. */
  orbit: [1550, 3200],
  /** Earth is a marble; planets hang in the distance. */
  deepSpace: [2400, ASCENT_MS],
  /** Stars stretch out and we punch into the dark. */
  vacuum: [3150, ASCENT_MS],
} as const;

/** Height through the atmosphere: drives the sky ramp, clouds and horizon.
 * Tops out well before the climb ends — you are in vacuum for the last third. */
export const ASCENT_ALTITUDE = [250, 2400] as const;

/** Distance from the planet: drives Earth's size and the far bodies. Kept
 * separate from altitude because the sky stops changing long before Earth
 * stops shrinking. */
export const ASCENT_DISTANCE = [1550, ASCENT_MS] as const;

/** Re-entry beats, in ms from the moment Back is pressed. */
export const REENTRY = {
  retroBurn: [0, 160],
  /** Earth swelling back up to fill the frame, then the air, then the ground. */
  fall: [100, 640],
  judder: [500, 800],
  settle: [780, REENTRY_MS],
} as const;

/** Reduced motion collapses both arcs to a plain cross-fade. */
export const REDUCED_MS = 200;

/** Set by `launch()`, read by BackControl: did this visitor arrive by warp?
 * Someone who came from the marketing landing is already in space and gets the
 * plain back-navigation instead of a re-entry they never earned. */
export const ARRIVED_BY_WARP_KEY = "orbit:arrived-by-warp";

/** Clamped linear progress of `t` through [a, b]. */
export function span(t: number, [a, b]: readonly [number, number]) {
  return Math.min(1, Math.max(0, (t - a) / (b - a)));
}

/** The house curve, as a function. Mirrors `--ease-house` in globals.css. */
export function easeHouse(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

/** Accelerating — used wherever the camera is gaining speed, so motion reads
 * as thrust rather than as a element sliding on a track. */
export function easeIn(t: number) {
  return t * t * t;
}

/** Damped oscillation for the touchdown judder: three shrinking bounces. */
export function judder(t: number) {
  return Math.sin(t * Math.PI * 6) * Math.pow(1 - t, 2.2);
}
