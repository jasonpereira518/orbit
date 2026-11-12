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
/** At the start, a star's streak reaches this fraction of the way back toward the origin; it
 *  shrinks to nothing as the warp slows. Stars far from the sun get long streaks, near ones
 *  short — the perspective of dropping out of lightspeed. */
export const STREAK_MAX = 0.5;
/**
 * Each star starts at a random fraction of its rest distance from the origin, in this range.
 *
 * High on purpose (Jason, Nov 12: "the whole screen should always be covered with stars"): every
 * star is already near its own place on the first frame, so the screen is full from the start
 * and nothing pours out of one point. The spread is what keeps it from reading as a uniform zoom.
 */
export const WARP_DEPTH_MIN = 0.82;
export const WARP_DEPTH_MAX = 0.97;

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

/**
 * Where a star's streak ends, as a `k` on the same line as its head: STREAK_MAX of the way
 * back toward the origin at the start, shrinking (quadratically in what is left of the warp)
 * to the head itself at p=1.
 */
export function warpTailK(headK: number, p: number): number {
  if (p >= 1) return headK;
  const left = 1 - p;
  return headK * (1 - STREAK_MAX * left * left);
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

/**
 * Where the warp streams from, or null to skip the warp.
 *
 * The solar system's box centre when it is on screen. The sky mounts after load + idle, which
 * can be seconds on a slow connection; a visitor who has scrolled the hero away by then would
 * get long parallel streaks from an off-screen sun behind what they are reading, so that gets no
 * warp at all (the same rule as a hash link). No box, or one not laid out yet: viewport centre.
 */
export function introOrigin(
  box: { left: number; top: number; width: number; height: number } | null | undefined,
  viewportW: number,
  viewportH: number
): { x: number; y: number } | null {
  if (!box || box.width <= 0 || box.height <= 0) return { x: viewportW / 2, y: viewportH / 2 };
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  if (x < 0 || x > viewportW || y < 0 || y > viewportH) return null;
  return { x, y };
}

export function skyAlpha(elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  return Math.min(1, elapsedMs / SKY_FADE_MS);
}

let warpStartedAt: number | null = null;

/**
 * When this page load's warp started (`performance.now()` time), or null for the plain sky.
 *
 * Shared rather than one-shot: React's development double-run mounts the sky, tears it down and
 * mounts it again, and a one-shot flag gave the second (real) mount nothing. A remount during
 * the warp continues it from the same start; one after it has ended gets the plain sky. The
 * attribute is gone after a client-side return to `/` (`LandingIntroGate`), so that is plain too.
 */
export function landingWarpStart(now: number): number | null {
  if (typeof document === "undefined") return null;
  if (!document.documentElement.hasAttribute(LANDING_INTRO_ATTR)) return null;
  if (prefersReducedMotion()) return null;
  warpStartedAt ??= now;
  return now - warpStartedAt < WARP_MS ? warpStartedAt : null;
}
