/**
 * The hero's choreography: every number the 3D scene (`hero-scene.ts`) and its DOM overlay
 * (`hero-pin.tsx`) have to agree on. Pure, with no three and no React, so the pin can import
 * it without pulling the scene's chunk into the first load, and `scripts/smoke-landing-hero.ts`
 * can check the framing arithmetic without a GPU.
 *
 * World space: the star sits at the origin and the system lies in the XZ plane, Y up.
 * Scroll progress `p` runs 0 → 1 across the pin.
 */
import { DORMANT_DAYS } from "@/lib/outreach-thresholds";

/** Pin length in svh. Three beats plus a plateau where the slider can be used. */
export const PIN_SVH = 400;

/**
 * The product's own thresholds. `QUIET_DAYS` is imported; `COMET_DAYS` mirrors
 * `COMET_DORMANT_DAYS` in `src/lib/comet.ts` (not imported: that file reaches the DB schema's
 * types, and this one ships to the browser). The smoke asserts the two stay equal.
 */
export const QUIET_DAYS = DORMANT_DAYS;
export const COMET_DAYS = 365;

/**
 * The three orbits. `side` is where the label sits in the top-down beat: 1 above, -1 below.
 * "Gone quiet" and "comet" are the app's own words for these two states (the Contacts
 * filter, the constellation's comets), so the page teaches the vocabulary a new user meets.
 */
export const RINGS = [
  { id: "inner", r: 3.2, name: "In touch", note: "talked this month", side: -1 },
  { id: "quiet", r: 5.4, name: "Gone quiet", note: `${DORMANT_DAYS} days without contact`, side: 1 },
  { id: "comet", r: 7.8, name: "Comet", note: "a year without contact", side: -1 },
] as const;

/** The slider's stops. Uneven on purpose: a week matters early, a quarter matters late. */
export const LAST_TALKED_STOPS = [
  { days: 0, label: "today" },
  { days: 3, label: "3 days ago" },
  { days: 7, label: "a week ago" },
  { days: 14, label: "2 weeks ago" },
  { days: 21, label: "3 weeks ago" },
  { days: 30, label: "a month ago" },
  { days: 45, label: "6 weeks ago" },
  { days: 60, label: "2 months ago" },
  { days: 90, label: "3 months ago" },
  { days: 120, label: "4 months ago" },
  { days: 180, label: "6 months ago" },
  { days: 270, label: "9 months ago" },
  { days: 365, label: "a year ago" },
  { days: 450, label: "15 months ago" },
  { days: 540, label: "18 months ago" },
] as const;
export const DEFAULT_STOP = 3;
const MAX_DAYS = LAST_TALKED_STOPS[LAST_TALKED_STOPS.length - 1].days;

/** What Orbit does with someone in each ring. One line each, shown under the slider. */
export const RING_VERDICTS = [
  "In touch. Nothing to do yet.",
  "Gone quiet. Orbit suggests reaching out.",
  "A comet. Orbit flags the few worth bringing back.",
] as const;

/** Which ring a person belongs to, by the product's rule. */
export function ringForDays(days: number): 0 | 1 | 2 {
  return days >= COMET_DAYS ? 2 : days >= QUIET_DAYS ? 1 : 0;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (v: number, a: number, b: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Log-spaced progress through [d0, d1]: early days move the world as far as late months. */
const logSpan = (d: number, d0: number, d1: number) =>
  clamp01((Math.log1p(d) - Math.log1p(d0)) / (Math.log1p(d1) - Math.log1p(d0)));

/**
 * Orbit radius for the slider's world. Each ring IS its threshold: a world reaches the
 * "Gone quiet" ring at exactly `QUIET_DAYS` and the "Comet" ring at exactly `COMET_DAYS`,
 * so what the ring's label says is true of a world sitting on it. Before a threshold the
 * world is on its way out to that ring; past the last one it drifts a little beyond it
 * (inside RING_MARGIN, so it stays in frame).
 *
 * The first month is linear, since a week matters there; the months after are log-spaced,
 * or the year between the two outer rings would be spent hugging the inner one.
 */
export function radiusForDays(days: number): number {
  const [inner, quiet, comet] = RINGS.map((ring) => ring.r) as [number, number, number];
  if (days < QUIET_DAYS) return lerp(inner, quiet, days / QUIET_DAYS);
  if (days < COMET_DAYS) return lerp(quiet, comet, logSpan(days, QUIET_DAYS, COMET_DAYS));
  return lerp(comet, comet * 1.07, logSpan(days, COMET_DAYS, MAX_DAYS));
}

/**
 * Scroll ranges, as fractions of the pin. Opacity scrubs in the pin and motion in the scene
 * both read these, so a retime happens in one place.
 */
export const BEATS = {
  /** Hero copy leaves. */
  copyOut: [0.05, 0.15],
  /** Camera lifts from the low hero angle to overhead. */
  lift: [0.06, 0.36],
  /** Orbit lines brighten and their labels arrive. */
  rings: [0.28, 0.4],
  /** The system claim and the slider arrive, hold, and leave. */
  systemIn: [0.33, 0.41],
  systemOut: [0.6, 0.66],
  /** Camera tips back for the comet's pass. */
  tip: [0.6, 0.74],
  /** The comet travels in. */
  comet: [0.66, 0.95],
  /** The comet claim and its card. */
  cometIn: [0.69, 0.77],
} as const;

/** Vertical field of view, degrees. Narrow: the worlds keep their shape near the frame edge. */
export const FOV = 34;
const TAN_HALF_FOV = Math.tan((FOV * Math.PI) / 360);
const OUTER = RINGS[2].r;
/** Room around the outer ring for its label. */
const RING_MARGIN = 1.14;
/**
 * The overhead beat has two layouts, and the scene and the DOM over it must pick the same
 * one. Side by side: a frame at least `SPLIT_MIN_WIDTH` wide and at least 6:5, where the
 * system takes the right of the frame and the claim and slider the left (the `split:`
 * variant in theme.css is this same test). Stacked, everywhere else: claim above, system
 * in the middle, slider below.
 *
 * A third layout, `still`, is not for the live scene: it frames the system to fill a square,
 * for the picture the static page shows instead (scripts/dev/capture-landing.mjs).
 *
 * Each entry is the share of the frame the system's diameter may take, and where its centre
 * sits: `across` from the frame's centre in half-widths, `down` in half-heights.
 */
const SPLIT_MIN_WIDTH = 1024;
const SPLIT_MIN_ASPECT = 6 / 5;
const SYSTEM_FIT = {
  split: { height: 0.74, width: 0.5, across: 0.32, down: 0.04 },
  stacked: { height: 0.5, width: 0.8, across: 0, down: 0.14 },
  still: { height: 0.84, width: 0.84, across: 0, down: 0 },
} as const;
export type Layout = keyof typeof SYSTEM_FIT;

/** The layout a live frame of this size gets. */
export function layoutFor(width: number, height: number): Layout {
  return width >= SPLIT_MIN_WIDTH && width / height >= SPLIT_MIN_ASPECT ? "split" : "stacked";
}

type Vec3 = [number, number, number];
export type CameraPose = { position: Vec3; target: Vec3 };

/** A camera on a sphere around `target`: `polar` from straight overhead, `azimuth` about Y. */
type Orbit = { polar: number; azimuth: number; distance: number; target: Vec3 };

const deg = (d: number) => (d * Math.PI) / 180;

/** Distance at which the outer ring fits its share of the frame from overhead. */
export function overheadDistance(aspect: number, layout: Layout): number {
  const fit = SYSTEM_FIT[layout];
  const reach = OUTER * RING_MARGIN;
  return Math.max(reach / (fit.height * TAN_HALF_FOV), reach / (fit.width * TAN_HALF_FOV * aspect));
}

function orbits(aspect: number, layout: Layout): { hero: Orbit; system: Orbit; comet: Orbit } {
  const wide = aspect >= 1;
  const split = layout === "split";
  const fit = SYSTEM_FIT[layout];
  const overhead = overheadDistance(aspect, layout);
  const halfHeight = overhead * TAN_HALF_FOV;
  // To put the system right of centre the camera looks left of it (−X); to put it below
  // centre, up-screen of it (−Z from overhead).
  const shift = -fit.across * halfHeight * aspect;
  const drop = fit.down * halfHeight;

  // The hero angle: low over the plane, the star up and to the right of where the camera
  // looks, so it lands in the frame's upper right and the copy keeps the lower left.
  const azimuth = deg(wide ? -24 : 25);
  const right: Vec3 = [Math.cos(azimuth), 0, -Math.sin(azimuth)];
  const forward: Vec3 = [-Math.sin(azimuth), 0, -Math.cos(azimuth)];
  const across = wide ? 4.3 : 1.5;
  const ahead = wide ? 2.6 : 3.6;
  return {
    hero: {
      polar: deg(wide ? 70 : 60),
      azimuth,
      distance: wide ? 9 : 17,
      target: [
        -across * right[0] - ahead * forward[0],
        0,
        -across * right[2] - ahead * forward[2],
      ],
    },
    system: { polar: deg(8), azimuth: 0, distance: overhead, target: [shift, 0, -drop] },
    // The comet's pass: tipped back for depth. Side by side it stays where the system was
    // and comes a little closer; stacked, the claim and its card need the top half, so the
    // system drops to the bottom of the frame (and the camera stays square on, or the
    // system slides off a narrow frame's left edge).
    comet: split
      ? { polar: deg(34), azimuth: deg(14), distance: overhead * 0.88, target: [shift, 0, -drop] }
      : { polar: deg(34), azimuth: 0, distance: overhead * 1.05, target: [0, 0, -0.62 * halfHeight] },
  };
}

function mix(a: Orbit, b: Orbit, t: number): Orbit {
  return {
    polar: lerp(a.polar, b.polar, t),
    azimuth: lerp(a.azimuth, b.azimuth, t),
    distance: lerp(a.distance, b.distance, t),
    target: [lerp(a.target[0], b.target[0], t), 0, lerp(a.target[2], b.target[2], t)],
  };
}

/**
 * Where the camera is and what it looks at, for scroll progress `p`, the frame's aspect, and
 * the layout that frame gets (see SYSTEM_FIT).
 */
export function cameraPose(p: number, aspect: number, layout: Layout = "stacked"): CameraPose {
  const { hero, system, comet } = orbits(aspect, layout);
  const lifted = mix(hero, system, smooth(p, BEATS.lift[0], BEATS.lift[1]));
  const o = mix(lifted, comet, smooth(p, BEATS.tip[0], BEATS.tip[1]));
  const s = Math.sin(o.polar);
  return {
    position: [
      o.target[0] + o.distance * s * Math.sin(o.azimuth),
      o.distance * Math.cos(o.polar),
      o.target[2] + o.distance * s * Math.cos(o.azimuth),
    ],
    target: o.target,
  };
}

/**
 * Where a world-space point lands in the frame: 0–1 from the left and from the top. The
 * scene does this with three's own camera; this is the same pinhole arithmetic without it,
 * for the static page (which lays labels over a still of the overhead beat) and the smoke.
 */
export function projectToFrame(
  p: number,
  aspect: number,
  point: Vec3,
  layout: Layout = "stacked",
): { x: number; y: number } {
  const { position, target } = cameraPose(p, aspect, layout);
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a: Vec3): Vec3 => {
    const length = Math.hypot(...a);
    return [a[0] / length, a[1] / length, a[2] / length];
  };
  const forward = unit(sub(target, position));
  const right = unit(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const v = sub(point, position);
  const depth = dot(v, forward);
  return {
    x: 0.5 + dot(v, right) / (2 * depth * TAN_HALF_FOV * aspect),
    y: 0.5 - dot(v, up) / (2 * depth * TAN_HALF_FOV),
  };
}

/**
 * The comet: in from beyond the outer ring, curving round to the inner one. `presence` is 0
 * before its beat, so the scene can hide it and skip loading the model until it is near.
 */
export function cometAt(p: number): { position: Vec3; presence: number } {
  const u = clamp01((p - BEATS.comet[0]) / (BEATS.comet[1] - BEATS.comet[0]));
  const eased = 1 - (1 - u) * (1 - u);
  const radius = lerp(13, RINGS[0].r + 0.5, eased);
  const angle = deg(205) + eased * 2.1;
  return {
    position: [radius * Math.cos(angle), lerp(1.4, 0.1, eased), radius * Math.sin(angle)],
    presence: smooth(p, BEATS.comet[0] - 0.02, BEATS.comet[0] + 0.04),
  };
}

/**
 * The worlds: each one a person. `ring` fixes the orbit; the one marked `live` takes its
 * radius from the slider instead. `size` is the sphere's radius in world units, `phase` its
 * starting angle. Worlds on one ring share a speed, so they never bunch up.
 *
 * The phases are a composition, not a scatter: from the hero angle they put Saturn far and
 * upper left, Jupiter near and right, and the slider's world mid-frame; from overhead they
 * keep every world clear of the ring labels (bottom of the inner and outer rings, top of the
 * middle one: Saturn's best place in the hero is the top of the outer ring). Change one and
 * look at both.
 */
export const WORLDS = [
  { id: "mercury", ring: 0, size: 0.17, phase: 3.9, live: false },
  { id: "venus", ring: 0, size: 0.26, phase: 0.07, live: false },
  { id: "earth", ring: 0, size: 0.28, phase: 3.21, live: true },
  { id: "mars", ring: 1, size: 0.21, phase: 3.73, live: false },
  { id: "jupiter", ring: 1, size: 0.56, phase: 0.7, live: false },
  { id: "saturn", ring: 2, size: 0.44, phase: 4.1, live: false },
  { id: "uranus", ring: 2, size: 0.3, phase: 0.52, live: false },
  { id: "neptune", ring: 2, size: 0.29, phase: 6.18, live: false },
] as const;
/**
 * Radians per second, per ring. Slow enough that a minute on the page moves the outer ring
 * by a few degrees: the composition above has to survive someone reading.
 */
export const RING_SPEED = [0.018, 0.011, 0.007] as const;

const V = "v1";
const hero = (name: string) => `/landing/hero/${name}-${V}`;
/** Earth's maps predate this page and keep their own folder. */
const mapOf = (id: string, tier: "1k" | "2k") =>
  id === "earth"
    ? `/landing/earth/earth-color-${tier === "1k" ? 1024 : 2048}.webp`
    : `${hero(`${id}-${tier}`)}.webp`;

export const HERO_ASSETS = {
  sun: { low: mapOf("sun", "1k"), high: mapOf("sun", "2k") },
  milkyWay: { low: `${hero("milkyway-1k")}.webp`, high: `${hero("milkyway-2k")}.webp` },
  world: (id: string) => ({ low: mapOf(id, "1k"), high: mapOf(id, "2k") }),
  saturnRing: `${hero("saturn-ring")}.webp`,
  nucleus: { model: `${hero("bennu")}.glb`, map: `${hero("bennu")}.webp` },
} as const;
