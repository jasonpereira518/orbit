/**
 * Motion tokens — TS mirror of the CSS `@theme` motion block in
 * `src/app/globals.css`. Keep the two in sync; values are duplicated
 * because reading computed styles is not SSR-safe.
 *
 * Two-tier personality: interactions are snappy (fast/base), hero moments
 * are celestial (slow/celestial on the house curve).
 */

/** House easing curve, as a motion/react ease array. */
export const EASE_HOUSE = [0.22, 1, 0.36, 1] as const;

/** Durations in seconds, for motion/react `transition.duration`. */
export const DUR = {
  fast: 0.12,
  base: 0.18,
  slow: 0.32,
  celestial: 0.7,
} as const;

/** Durations in milliseconds, for rAF loops and timeouts. */
export const DUR_MS = {
  fast: 120,
  base: 180,
  slow: 320,
  celestial: 700,
} as const;

/** The one spring for every shared-element `layoutId` pill. */
export const SPRING_PILL = {
  type: "spring",
  stiffness: 420,
  damping: 34,
} as const;

/** Soft spring for decorative glides (onboarding tour cursor). */
export const SPRING_SOFT = {
  type: "spring",
  stiffness: 170,
  damping: 22,
} as const;

/** React Flow camera tween durations (ms). */
export const CAMERA_MS = {
  move: 450,
  wide: 550,
} as const;

/**
 * Clamped linear progress of `v` through [a, b], for scroll scrubs.
 *
 * Scrubbed opacity/pathLength MUST use function transforms built on this —
 * never `useTransform(value, [a,b], [x,y])` range maps. motion promotes
 * range-mapped opacity to a WAAPI ViewTimeline animation tracking the
 * *element's* viewport position, which disagrees with target-based
 * `useScroll` offsets inside sticky pins (values run out and back in).
 * Function transforms cannot be keyframe-extracted, so they stay JS-driven.
 */
export function scrub01(v: number, a: number, b: number) {
  return Math.min(1, Math.max(0, (v - a) / (b - a)));
}
