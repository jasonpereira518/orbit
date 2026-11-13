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
 *
 * On localhost it plays on every load, not once per session (Jason, Nov 12), so the intro can be
 * watched while working on it. The hash and reduced-motion skips still apply there.
 */
export const LANDING_INTRO_PREPAINT_SCRIPT = `try{var d=document.documentElement,h=location.hostname,dev=h==="localhost"||h==="127.0.0.1"||h==="[::1]"||/\\.localhost$/.test(h);if(!location.hash&&d.getAttribute("data-motion")!=="reduce"&&!matchMedia("(prefers-reduced-motion: reduce)").matches&&(dev||!sessionStorage.getItem(${JSON.stringify(LANDING_INTRO_KEY)}))){sessionStorage.setItem(${JSON.stringify(LANDING_INTRO_KEY)},"1");d.setAttribute(${JSON.stringify(LANDING_INTRO_ATTR)},"")}}catch(e){}`;

/*
 * The flight (Jason, Nov 12: "like you are zooming to space and then you arrive at the solar
 * system", and earlier: "the whole screen should always be covered with stars").
 *
 * Each star lives on the line from the vanishing point (the sun) through its rest position, at
 * `k = e^u` of the way out. `u` is depth in log space, which is what makes it read as flying
 * forward: equal steps in `u` are equal steps of travel, so stars near the sun creep and stars
 * near the edge race past. Stars stream outward and, past the edge of their lap, wrap back to the
 * vanishing point, like flying through an endless field; their per-star lap offsets spread them
 * over every depth at once, so the screen is full on every frame. Then the flight decelerates and
 * each star's final lap ends exactly at u=0, its rest position, which is the arrival.
 *
 * Tuning knobs, set by eye in the browser. Toned down Nov 12 (Jason: "a little less dramatic"):
 * travel 7 -> 4.5 (slower flight), streak 70ms -> 45ms (shorter streaks).
 */
export const WARP_MS = 2400;
/** The sky's background and stars fade up over this, so the canvas does not pop in. */
export const SKY_FADE_MS = 400;
/** A streak runs from where its star was this long ago to where it is now. Time, not frames,
 *  so a slow machine draws the same streak length as a fast one; it is the speed, so it
 *  collapses to a point on arrival. */
export const STREAK_LAG_MS = 45;
/** One lap in log depth: a star respawns at e^-LAP (about 1/11) of its rest distance. */
export const WARP_LAP = 2.4;
/** Total log depth flown. TRAVEL / LAP is roughly how many times each star streams past. */
export const WARP_TRAVEL = 4.5;
/** Each star flies up to this much further than WARP_TRAVEL. Several laps wide, so the stars
 *  stay mixed across every depth well into the flight instead of bunching into one copy of the
 *  sky at a single scale. */
export const WARP_EXTRA_SPAN = 3 * WARP_LAP;
/**
 * Temporary stars rest off-screen, out to this multiple of the screen's distance from the sun.
 * As the flight slows every star closes in on its rest from the sun's side, which would empty
 * the edges; these fill them, and land off-screen exactly when the flight ends, leaving the
 * plain sky.
 */
export const WARP_FIELD_REACH = 2;
/** A respawned star fades up over this much of its lap, so nothing pops in at the sun. */
const RESPAWN_FADE = 0.35;

/** Eased 0→1 over WARP_MS: fastest at the start (already at speed), decelerating to arrive. */
export function warpProgress(elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  if (elapsedMs >= WARP_MS) return 1;
  const t = elapsedMs / WARP_MS;
  return 1 - (1 - t) ** 3;
}

/**
 * A star's log depth `u` at progress `p`. Exactly 0 (its rest position) at p=1; before that it
 * streams outward and wraps back by one lap at a time.
 *
 * Two random numbers per star, both in [0, WARP_LAP): `offset` places its laps, `extra` adds to
 * the distance it flies. The extra is what spreads the stars over every depth on the first frame;
 * with the offset alone every star would sit at the same depth and the flight would read as a
 * plain zoom.
 */
export function warpLogK(offset: number, extra: number, p: number): number {
  if (p >= 1) return 0;
  const v = -(WARP_TRAVEL + extra) * (1 - p);
  const lap = (((v + offset) % WARP_LAP) + WARP_LAP) % WARP_LAP;
  return lap - offset;
}

/**
 * The share of stars that fly (Jason, Nov 12: "Make it less dense when warping"). The rest stay
 * hidden during the flight and fade up at their places as it lands, from p = SHARE_FADE_FROM.
 */
export const WARP_SHARE = 0.45;
const SHARE_FADE_FROM = 0.85;

/** Visibility factor for a star picked by `pick` in [0, 1): 1 if it flies, else 0 until the
 *  arrival, fading to 1 by p=1. */
export function warpShareAlpha(pick: number, p: number): number {
  if (pick < WARP_SHARE || p >= 1) return 1;
  return Math.max(0, (p - SHARE_FADE_FROM) / (1 - SHARE_FADE_FROM));
}

/** Brightness factor: faint just after a respawn at the sun, always full by arrival. */
export function warpStarAlpha(offset: number, extra: number, p: number): number {
  if (p >= 1) return 1;
  const lapPos = warpLogK(offset, extra, p) + offset;
  return Math.max(Math.min(1, lapPos / RESPAWN_FADE), p);
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
