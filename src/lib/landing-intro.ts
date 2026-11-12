import { prefersReducedMotion } from "@/lib/motion-preference";

/**
 * The landing page's first-visit intro: the hero text staggers in, the sky's real stars warp out
 * of the solar system's centre into their resting places, and the solar system grows out of the
 * warp. Once per tab session. Design: docs/superpowers/specs/2026-11-12-landing-intro-warp-design.md.
 *
 * No React or Next imports: the smoke runs this under plain tsx, and the starfield chunk
 * imports it without pulling anything else in.
 */

export const LANDING_INTRO_KEY = "orbit:landing-intro";
export const LANDING_INTRO_ATTR = "data-landing-intro";

/**
 * Marks `<html>` before first paint when this tab has not seen the intro yet, so CSS can stagger
 * the text and swap the solar system's entrance with no flash of the plain version.
 *
 * Skipped for a hash link (the visitor lands mid-page, away from the hero), for reduced motion
 * (system setting, or Orbit's own `data-motion="reduce"`, which the root layout's
 * `MOTION_PREPAINT_SCRIPT` has already set by the time this runs), and wherever storage throws.
 */
export const LANDING_INTRO_PREPAINT_SCRIPT = `try{var d=document.documentElement;if(!location.hash&&d.getAttribute("data-motion")!=="reduce"&&!matchMedia("(prefers-reduced-motion: reduce)").matches&&!sessionStorage.getItem(${JSON.stringify(LANDING_INTRO_KEY)})){sessionStorage.setItem(${JSON.stringify(LANDING_INTRO_KEY)},"1");d.setAttribute(${JSON.stringify(LANDING_INTRO_ATTR)},"")}}catch(e){}`;

/* Tuning knobs. Starting points; set by eye in the browser. */
export const WARP_MS = 1600;
/** The sky's background and stars fade up over this, so the canvas does not pop in. */
export const SKY_FADE_MS = 400;
/** A streak runs from where its star was this long ago to where it is now. Time, not frames,
 *  so a slow machine draws the same streak length as a fast one. */
export const STREAK_LAG_MS = 60;
/** Each star starts at a random fraction of its rest distance from the origin, in this range.
 *  Different starting depths are what make it a warp rather than a uniform zoom. */
export const WARP_DEPTH_MIN = 0.02;
export const WARP_DEPTH_MAX = 0.35;

/** Eased 0→1 over WARP_MS (ease-out cubic: fast out of the warp, settling into place). */
export function warpProgress(elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  if (elapsedMs >= WARP_MS) return 1;
  const t = elapsedMs / WARP_MS;
  return 1 - (1 - t) ** 3;
}

/** How far along its line a star is: its starting depth at p=0, exactly 1 at p=1. */
export function warpK(depth0: number, p: number): number {
  return p >= 1 ? 1 : depth0 + (1 - depth0) * p;
}

/** Where a star is drawn: on the line from the origin to its rest position, `k` of the way. */
export function warpPoint(
  restX: number,
  restY: number,
  ox: number,
  oy: number,
  k: number
): { x: number; y: number } {
  if (k === 1) return { x: restX, y: restY };
  return { x: ox + (restX - ox) * k, y: oy + (restY - oy) * k };
}

export function skyAlpha(elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  return Math.min(1, elapsedMs / SKY_FADE_MS);
}

let taken = false;

/**
 * Whether this mount of the landing sky should play the warp. True at most once per page load:
 * a remount (the effect re-running, a client-side return to `/`) gets the plain sky.
 */
export function takeLandingIntro(): boolean {
  if (taken || typeof document === "undefined") return false;
  if (!document.documentElement.hasAttribute(LANDING_INTRO_ATTR)) return false;
  if (prefersReducedMotion()) return false;
  taken = true;
  return true;
}
