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

/** Milliseconds from launch to the cruise hold. Deterministic. */
export const ASCENT_MS = 1650;

/**
 * When the stage is fully opaque and the route swap becomes invisible.
 *
 * The push cannot happen at t=0: navigating unmounts the whole `(app)` layout,
 * which takes `[data-warp-craft]` — the element visibly flying away — with it.
 * So we wait until the atmosphere covers the frame, then swap behind it.
 */
export const ASCENT_OPAQUE_MS = 900;

/** Deceleration + handoff to the real starfield, once /pricing has painted. */
export const ARRIVAL_MS = 450;

/**
 * Hard ceiling on the cruise hold. A route that never resolves must not strand
 * anyone on a black screen, so the stage force-resolves regardless.
 */
export const CRUISE_CAP_MS = 4000;

/** The fall home, start to settled. */
export const REENTRY_MS = 750;

/** Ascent beats, in ms from launch. Overlapping on purpose — the sky is
 * already brightening while the dashboard is still on its way down. */
export const ASCENT = {
  ignition: [0, 180],
  liftoff: [140, 820],
  atmosphere: [420, 1300],
  vacuum: [1150, ASCENT_MS],
} as const;

/** Re-entry beats, in ms from the moment Back is pressed. */
export const REENTRY = {
  retroBurn: [0, 120],
  fall: [80, 500],
  judder: [350, 620],
  settle: [600, REENTRY_MS],
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

/** Linear blend. `t` is expected pre-clamped by `span`. */
export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
