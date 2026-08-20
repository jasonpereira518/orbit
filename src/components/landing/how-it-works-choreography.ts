/**
 * Beat map for the "From a conversation to a callback" pin.
 *
 * Both writers import from here: the DOM (ring, sun, arc, node markers,
 * labels) via motion values in landing-how-it-works.tsx, and the WebGL globe
 * via its own rAF in earth-globe.tsx. Neither derives geometry on its own —
 * if they did, the sphere would drift off the dashed line the first time a
 * beat is retimed.
 *
 * Progress `p` is the pin wrapper's scrollYProgress under
 * offset ["start start", "end end"].
 */

import { scrub01 } from "@/lib/motion";

/** Pin wrapper height. ~3.6 viewports of scrub once the sticky frame's own
 * 100svh is subtracted — enough room for six beats without dragging. */
export const PIN_SVH = 500;

export const BEATS = {
  /** Earth shrinks and travels centre → 12 o'clock. */
  pullBack: [0.08, 0.26],
  /** Ring, sun and caption fade in — as a complete circle, no draw-on. */
  sceneIn: [0.1, 0.24],
  /** Step 01 lights at the top node, before the orbit starts moving. */
  step0: [0.24, 0.32],
  /** θ sweeps 0 → 360° clockwise from 12 o'clock. The window is narrower
   * than it was, but PIN_SVH grew to match — the orbit covers the same
   * scroll distance and the difference all goes to the zoom. */
  orbit: [0.28, 0.78],
  /** Earth returns to centre and grows to fill the frame. Twice the runway
   * it used to have: the approach is the moment the whole scene builds to,
   * and rushing it undercut the arrival. */
  zoomIn: [0.78, 0.92],
  /** …then lifts, easing back a little as it goes. It has to travel most of
   * its own radius before its lower limb clears the bottom of the frame —
   * that curve is the whole point of the exit, so the rise is generous and
   * the pin releases with it already in view. */
  riseOut: [0.92, 1],
  /** Everything except Earth clears out. */
  sceneOut: [0.78, 0.86],
} as const satisfies Record<string, readonly [number, number]>;

/** Widest the ring stage is ever drawn. */
export const STAGE_MAX = 760;
/** Floor for the stage. Reached only on very short lg windows (~620px tall);
 * below that the bottom label starts to clip rather than the ring shrinking
 * into illegibility. */
export const STAGE_MIN = 280;
/** Ring radius as a fraction of the stage — matches the dashed border's
 * inset-[6%], whose radius is 44% of the box. */
export const RING_RATIO = 0.44;
/** Earth's radius on the ring, as a fraction of the stage. Sized against the
 * 78px sun at the centre — much smaller and it stops reading as a body. */
export const EARTH_RATIO = 0.065;
/** Label box, and its clearance from the edge of Earth's path. */
export const LABEL_W = 230;
export const LABEL_H = 100;
export const LABEL_GAP = 22;
/** The fixed header pill floats over the top of the pin — the composition
 * has to centre below it, not in the raw frame, or the 12 o'clock label
 * lands underneath it. */
export const HEADER_CLEARANCE = 100;
/** Breathing room under the 6 o'clock step, so its body copy doesn't run to
 * the bottom edge of the frame. */
export const BOTTOM_CLEARANCE = 72;

/** Outermost radius Earth reaches, as a fraction of the stage. */
const OUTER = RING_RATIO + EARTH_RATIO;

/** Vertical centre of the composition, in frame space — the middle of the
 * band left between the header and the bottom gutter. */
export function centreY(h: number) {
  return (HEADER_CLEARANCE + (h - BOTTOM_CLEARANCE)) / 2;
}

/**
 * Side of the square the ring is drawn in — the largest that still leaves
 * each of the four outward labels inside the frame.
 *
 * The DOM mirrors this as a CSS expression for the pre-measurement paint
 * (STAGE_CSS in landing-how-it-works.tsx, generated from these same
 * constants) and then pins it to this exact value once the frame is
 * measured: the WebGL globe and the dashed ring have to agree on the radius
 * to the pixel or Earth drifts off the line.
 */
export function stageSize(w: number, h: number) {
  const halfBand = (h - HEADER_CLEARANCE - BOTTOM_CLEARANCE) / 2;
  const byHeight = (halfBand - (LABEL_H + LABEL_GAP)) / OUTER;
  const byWidth = (w / 2 - (LABEL_W + LABEL_GAP + 16)) / OUTER;
  return Math.max(STAGE_MIN, Math.min(STAGE_MAX, byHeight, byWidth));
}

/** Frame-space geometry, in CSS pixels. Origin is the frame's top-left. */
export type Geom = {
  /** Sticky frame width. */
  w: number;
  /** Sticky frame height. */
  h: number;
  /** Radius of the dashed orbit ring, about the frame centre. */
  ringR: number;
};

/** Decelerating — the pull-back settles onto the ring rather than snapping. */
function easeOut(t: number) {
  return 1 - (1 - t) * (1 - t);
}


/** Accelerating — the finale gathers speed into the scroll-away. */
/** Slow in, slow out — the approach accelerates, then settles. */
function smoothstep(t: number) {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/** θ in radians at progress `p`. 0 = 12 o'clock, increasing clockwise. */
export function orbitTheta(p: number) {
  return scrub01(p, ...BEATS.orbit) * Math.PI * 2;
}

/** Progress at which Earth reaches step `i`'s node (i·90° around the ring). */
function stepArrival(index: number) {
  const [a, b] = BEATS.orbit;
  return a + ((b - a) * index) / 4;
}

/**
 * Reveal window for step `i` — derived from the orbit timing rather than
 * hardcoded, so retiming BEATS.orbit can't desync the copy from the planet.
 * It opens slightly before arrival so the label is legible by the time Earth
 * is on top of it.
 */
export function stepWindow(index: number): [number, number] {
  if (index === 0) return [...BEATS.step0];
  const at = stepArrival(index);
  return [at - 0.05, at + 0.03];
}

/** How far the globe recedes across the whole departure. */
const DEPART_SHRINK = 0.62;

/**
 * Earth's placement and key-light direction.
 *
 * `p` is the pin's own progress, clamped at 1 once the sticky frame reaches
 * the end of its travel. `depart` picks up exactly there and runs 0 → 1 as
 * the frame scrolls off the top, which is the only way to keep the globe
 * receding after the pin has stopped driving it.
 */
export function earthAt(p: number, g: Geom, depart = 0) {
  const cx = g.w / 2;
  const cy = centreY(g.h);

  // Radius at each of the four anchor poses.
  const orbitR = (g.ringR / RING_RATIO) * EARTH_RATIO;
  const heroR = Math.min(g.w, g.h) * 0.34;
  // Just past the frame's corner radius: full-bleed with no margin to spare,
  // and no further. Pushing deeper only magnifies one patch of ocean until it
  // reads as the camera being inside the planet rather than in front of it.
  const fullR = Math.hypot(g.w, g.h) * 0.53;
  // A slight pull-back on the way out — enough to read as the planet
  // receding rather than merely sliding off the top of the frame.
  const exitR = fullR * 0.82;

  const out = easeOut(scrub01(p, ...BEATS.pullBack));
  const zin = smoothstep(scrub01(p, ...BEATS.zoomIn));
  const theta = orbitTheta(p);

  // Screen axes here: y grows downward, matching the DOM ring.
  const ringX = cx + g.ringR * Math.sin(theta);
  const ringY = cy - g.ringR * Math.cos(theta);

  // Double lerp: centre → ring, then ring → centre for the finale.
  const x = lerp(lerp(cx, ringX, out), cx, zin);

  // Linear, so the lift matches the scroll that drives it rather than
  // easing away from the reader's thumb. Rise and pull-back share the same
  // progress, so they read as one gesture.
  const rise = scrub01(p, ...BEATS.riseOut);
  const r = lerp(lerp(lerp(heroR, orbitR, out), fullR, zin), exitR, rise);
  const yCentred = lerp(lerp(cy, ringY, out), g.h / 2, zin);
  // Ends with the bottom of the globe just above the frame's lower edge —
  // measured off exitR so the limb lands there whatever the pull-back does.
  const yRisen = 0.84 * g.h - exitR;
  const y = lerp(yCentred, yRisen, rise);

  // Keep pulling back on the way out. The centre stays put above the frame,
  // so shrinking lifts the visible limb faster than the scroll does and the
  // globe reads as receding rather than merely sliding away.
  const departed = lerp(1, DEPART_SHRINK, depart);

  // Key light. On the ring the sun is at frame centre, so the direction from
  // Earth toward it is -(sinθ, cosθ) in three's world axes (y up). The +z
  // bias keeps a sliver of day facing the camera at θ=180°, where Earth would
  // otherwise present a fully eclipsed disc.
  //
  // During the opening hold and the finale there is no sun on screen to
  // motivate that angle, so blend toward a fixed three-quarter key. `track`
  // reaches 1 only while Earth is actually travelling the ring.
  const track = Math.min(out, 1 - zin);
  // The trail only exists while Earth is actually travelling the ring.
  const onRing = track * scrub01(p, BEATS.orbit[0] - 0.02, BEATS.orbit[0] + 0.04);
  const lx = lerp(-0.45, -Math.sin(theta), track);
  const ly = lerp(0.25, -Math.cos(theta), track);
  const lz = lerp(0.9, 0.35, track);
  const len = Math.hypot(lx, ly, lz) || 1;

  return {
    x,
    y,
    r: r * departed,
    theta,
    onRing,
    light: [lx / len, ly / len, lz / len] as [number, number, number],
  };
}
