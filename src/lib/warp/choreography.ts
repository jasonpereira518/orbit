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
export const ASCENT_MS = 7000;

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
export const CRUISE_CAP_MS = 9500;

/** The fall home, start to settled. Still a quarter of the climb: you fall
 * back to Earth, you don't tour it. */
export const REENTRY_MS = 1500;

/**
 * Ascent beats, in ms from launch.
 *
 * There is no sky ramp any more: the trip starts above the atmosphere with
 * Earth already filling the frame, so the old ground/cloud/stratosphere bands
 * are gone and the budget goes to the tour instead.
 */
export const ASCENT = {
  /** Engines light; the dashboard judders but has not moved yet. */
  ignition: [0, 300],
  /** The dashboard drops away, uncovering an Earth that already fills the frame. */
  departure: [200, 1200],
  /** Earth shrinks to a globe low in frame; satellites and a departing craft. */
  recede: [1000, 2300],
  /** Six worlds, passed one at a time. */
  tour: [2100, 6900],
  /** Stars stretch out and we punch into the dark. */
  vacuum: [6400, ASCENT_MS],
} as const;

/** Earth's retreat, from edge-to-edge down to a marble. Its own window because
 * it starts before the tour and has to be finished well before the tour ends. */
export const EARTH_RECEDE = [850, 3900] as const;
/** ...and then it is simply too far to still be drawing. */
export const EARTH_FADE = [3500, 4400] as const;

/**
 * The road out.
 *
 * `at` is the moment of closest approach, `side` which way it sweeps, `close`
 * its radius at that moment as a fraction of viewport height — over 1.0 means
 * it crops the frame. `lateral` is how far out it swings; a small value keeps
 * a big planet near the middle so it fills the screen rather than sliding off
 * the corner early.
 *
 * Jupiter and Saturn are the hero passes. Uranus and Neptune deliberately go
 * quiet, so the last stretch has somewhere to build from.
 */
export const FLYBYS = [
  { kind: "moon", at: 2500, side: 1, close: 0.55, lateral: 0.42, lead: 640, trail: 700 },
  { kind: "mars", at: 3250, side: -1, close: 0.55, lateral: 0.5, lead: 640, trail: 700 },
  { kind: "jupiter", at: 4100, side: 1, close: 1.5, lateral: 0.3, lead: 700, trail: 760 },
  { kind: "saturn", at: 5000, side: -1, close: 1.1, lateral: 0.34, lead: 700, trail: 760 },
  { kind: "uranus", at: 5750, side: 1, close: 0.45, lateral: 0.52, lead: 620, trail: 680 },
  { kind: "neptune", at: 6350, side: -1, close: 0.62, lateral: 0.46, lead: 620, trail: 650 },
] as const;

/**
 * How far away a world starts, relative to its closest approach.
 *
 * Distance falls exponentially across a flyby — constant speed in log space —
 * which is what produces the accelerating whoosh. A linear ramp slides; this
 * one hangs in the distance and then arrives all at once.
 *
 * Tuned down from 26: that was so back-loaded each world spent most of its
 * window as a speck, and the frame went bare in the gaps between passes. Lower
 * means worlds arrive with more presence and overlap each other; much lower
 * and the approach stops accelerating and starts sliding.
 */
export const FLYBY_DEPTH = 15;

/** Re-entry beats, in ms from the moment Back is pressed. */
export const REENTRY = {
  retroBurn: [0, 200],
  /** Worlds rushing back past, then Earth swelling, then air, then ground. */
  fall: [120, 1150],
  judder: [1000, 1360],
  settle: [1340, REENTRY_MS],
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
