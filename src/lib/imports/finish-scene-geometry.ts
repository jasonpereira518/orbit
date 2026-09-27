/**
 * The done card's arrival, as maths with no canvas in it.
 *
 * The people an import added fall in from beyond the top-left corner under Earth's pull, speed
 * up as they drop, swing round it fastest at their closest pass, and from there only ever slow
 * down — fanning out forward round three tilted rings until each one is sitting in its own place
 * and turning with its ring. The headline counts one for every body that settles.
 *
 * Three rules shape everything below, and each came from watching an earlier version:
 *
 * - **Gravity, not a swarm.** Each approach is a parabolic fall (Barker's equation gives position
 *   against time), so a body is slow and small far out and fastest at the bottom of the fall. No
 *   jitter, no flocking.
 * - **One speed-up, then only slowing.** After its closest pass a body's angular speed falls
 *   monotonically from the pass speed to its ring's resting speed, along a curve that is flat at
 *   both ends. Nothing brakes into a holding orbit and then accelerates again to spread out —
 *   that was the version that read as stop-start.
 * - **Nobody goes backward, nobody overtakes.** Every body travels forward to its place. Within a
 *   ring, the body captured last takes the nearest place and the first captured the farthest, so
 *   the leader stays the leader.
 *
 * Bounded: at most `MAX_FACES` faces and `MAX_DOTS` dots however many people arrived. 3,000
 * people is 36 bodies and a sentence that says 3,000; the count scales each settle to people.
 * Every random choice comes from a generator seeded by the body count, so a scene is the same
 * each time it is drawn.
 */
export const MAX_FACES = 12;
export const MAX_DOTS = 24;
export const SCENE_HEIGHT = { desktop: 180, phone: 120 } as const;
/** Below this canvas height the scene uses its phone sizes. */
const PHONE_BELOW = 150;
/** The orbital plane's tilt: a ring's drawn height over its width. */
export const TILT = 0.32;
/** Ring radii as fractions of the outer ring's. Faces ride the middle ring. */
export const RING_FRACTIONS = [0.46, 0.73, 1] as const;
/** Seconds per lap at rest, inner to outer: every ring turns the same way, the inner fastest. */
export const RING_LAP_SECONDS = [40, 65, 100] as const;
/** The planet's slow zoom in and out: ±4.5% over 3.6 seconds. */
export const BREATH = { amplitude: 0.045, seconds: 3.6 } as const;
export const FACE_RADIUS = { desktop: 12, phone: 10 } as const;
export const PLANET_SIZE = { desktop: 46, phone: 34 } as const;
export const DOT_RADIUS = 3.6;
/** How long a face takes to turn from its initials into its photo. */
export const PHOTO_REVEAL_SECONDS = 0.7;
/** The outer ring never grows past this, so a normal import clusters rather than sprawls. */
const MAX_OUTER_RADIUS = 280;

/** How long the fall from the corner to the closest pass takes. */
const APPROACH_SECONDS = 1.5;
/** The last body sets off this long after the first, at most. */
const MAX_STAGGER_SECONDS = 0.5;
/** Every body travels at least this far round after its closest pass, so none stops dead. */
const MIN_TRAVEL = 2.5;
/** The parabola starts 120° before its closest pass: four times the pass distance out. */
const START_ANOMALY = (-2 * Math.PI) / 3;
/** Where, round the rings, the closest pass falls: just right of the top, behind the planet. */
const PASS_ANGLE = -0.406;

const TAU = Math.PI * 2;
const START_D = Math.tan(START_ANOMALY / 2);
/** Barker's time constant for the whole fall, in its own units. */
const FALL = -(START_D + (START_D * START_D * START_D) / 3);

export type SceneBody = {
  /** Which face this is, in the order the faces were passed; -1 for a plain dot. */
  faceIndex: number;
  ring: 0 | 1 | 2;
  /** Picks the body's colour from the palette. */
  colorIndex: number;
  /** The ring's radius this body ends on. */
  radius: number;
  /** Its ring's resting angular speed, radians per second. */
  restSpeed: number;
  /** Its place on the ring at time zero; the ring's turning carries it from there. */
  slot: number;
  /** Distance of the closest pass, and the ring angle it happens at. */
  passRadius: number;
  passAngle: number;
  /** When it sets off, and when it makes its closest pass. */
  start: number;
  pass: number;
  /** How far it travels round beyond its ring's own turning, after the pass. */
  travel: number;
  /** How long it takes to slow from the pass to its ring's speed. */
  slowing: number;
  /** Shape of that slowing curve (see `slowed`). */
  shape: number;
  /** Pass speed minus resting speed. */
  surplus: number;
  /** When it is in place: the count ticks here. */
  settleAt: number;
};

export type Scene = {
  width: number;
  height: number;
  cx: number;
  cy: number;
  radii: [number, number, number];
  bodies: SceneBody[];
  /** The real number of people, which the count ends on. */
  people: number;
  faceRadius: number;
  planetSize: number;
  /** When the last body settles. */
  duration: number;
};

export type Pose = { x: number; y: number; /** 0 is the back of the plane, 1 the front. */ depth: number };

/** How many faces and dots stand in for this many people. */
export function bodiesFor(people: number): { faces: number; dots: number } {
  const n = Math.max(0, Math.floor(people));
  const faces = Math.min(MAX_FACES, n);
  return { faces, dots: Math.min(MAX_DOTS, n - faces) };
}

/** mulberry32: small, fast, and the same sequence for the same seed everywhere. */
function seeded(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number): number {
  const u = Math.max(1e-6, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * random());
}

const mod = (x: number, m: number) => ((x % m) + m) % m;

/** Smoothstep: flat at both ends. */
function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * How far a body has come, as a fraction of `surplus * slowing`, at fraction `s` of its slowing.
 *
 * The speed curve is `(1 - s)^k (1 + k s)`: 1 at the pass, 0 at the end, flat at both ends for
 * k > 1 and never rising. This is its integral, closed form, so the total at s = 1 is 2 / (k + 2)
 * and `shape` is chosen so that total lands the body exactly on its place.
 */
function slowed(s: number, k: number): number {
  const v = 1 - Math.min(1, Math.max(0, s));
  return 2 / (k + 2) - Math.pow(v, k + 1) + (k * Math.pow(v, k + 2)) / (k + 2);
}

/** Barker's equation, solved for the half-angle tangent at scaled time `tau`. */
function barker(tau: number): number {
  const root = Math.sqrt(2.25 * tau * tau + 1);
  return Math.cbrt(1.5 * tau + root) + Math.cbrt(1.5 * tau - root);
}

/** Every body's path, fixed up front, for a canvas of this size. */
export function buildScene(people: number, width: number, height: number): Scene {
  const { faces, dots } = bodiesFor(people);
  const count = faces + dots;
  const phone = height < PHONE_BELOW;
  const faceRadius = phone ? FACE_RADIUS.phone : FACE_RADIUS.desktop;
  const reach = faceRadius + 3;
  const outer = Math.max(
    0,
    Math.min(MAX_OUTER_RADIUS, width / 2 - reach, (height / 2 - reach) / TILT),
  );
  const radii = RING_FRACTIONS.map((f) => outer * f) as [number, number, number];
  const middle = radii[1];
  const stagger = Math.min(MAX_STAGGER_SECONDS, 0.04 * count);
  const passSpeed = (2 * FALL) / APPROACH_SECONDS;
  const random = seeded(count * 7919 + 11);

  type Draft = { faceIndex: number; ring: 0 | 1 | 2; colorIndex: number };
  const drafts: Draft[] = [];
  for (let j = 0; j < faces; j++) drafts.push({ faceIndex: j, ring: 1, colorIndex: j });
  const inner = Math.round((dots * radii[0]) / Math.max(1e-6, radii[0] + radii[2]));
  for (let j = 0; j < inner; j++) drafts.push({ faceIndex: -1, ring: 0, colorIndex: j + 2 });
  for (let j = 0; j < dots - inner; j++) drafts.push({ faceIndex: -1, ring: 2, colorIndex: j + 5 });

  const slots: number[][] = [
    Array.from({ length: inner }, (_, j) => (TAU * (j + 0.5)) / inner),
    // Faces are spaced evenly with one at the front, where it reads best.
    Array.from({ length: faces }, (_, j) => Math.PI / 2 + (TAU * j) / faces),
    Array.from({ length: dots - inner }, (_, j) => (TAU * j) / (dots - inner)),
  ];

  // Set-off order: a golden-ratio shuffle, so faces and dots and the three rings interleave.
  const order = drafts
    .map((draft, i) => ({ draft, key: (i * 0.6180339887) % 1 }))
    .sort((a, b) => a.key - b.key)
    .map(({ draft }) => draft);

  const bodies: SceneBody[] = order.map((draft, i) => {
    const restSpeed = TAU / RING_LAP_SECONDS[draft.ring];
    const start = count <= 1 ? 0 : stagger * (i / (count - 1));
    return {
      ...draft,
      radius: radii[draft.ring],
      restSpeed,
      slot: 0,
      passRadius: middle * (1 + 0.08 * gaussian(random)),
      passAngle: PASS_ANGLE + 0.1 * gaussian(random),
      start,
      pass: start + APPROACH_SECONDS,
      travel: 0,
      slowing: 0,
      shape: 0,
      surplus: passSpeed - restSpeed,
      settleAt: 0,
    };
  });

  let duration = 0;
  for (const ring of [0, 1, 2] as const) {
    const mine = bodies.filter((b) => b.ring === ring);
    if (!mine.length) continue;
    // Where each body would sit if it had turned with the ring from its pass: the slot it can
    // reach by travelling forward is measured from here.
    const phase = (b: SceneBody) => b.passAngle - b.restSpeed * b.pass;
    const first = mine.reduce((a, b) => (b.pass < a.pass ? b : a), mine[0]);
    const ahead = slots[ring]
      .map((angle) => ({ angle, gap: mod(angle - phase(first) - MIN_TRAVEL, TAU) }))
      .sort((a, b) => a.gap - b.gap);
    // Last captured takes the nearest place, first captured the farthest: nobody overtakes.
    [...mine]
      .sort((a, b) => b.pass - a.pass)
      .forEach((body, k) => {
        body.slot = ahead[k].angle;
        body.travel = mod(body.slot - phase(body) - MIN_TRAVEL, TAU) + MIN_TRAVEL;
        let slowing = 1.8 + ((body.travel - MIN_TRAVEL) / TAU) * 1.1;
        // Keep the slowing curve flat where it lands (k > 1); a long trip needs a longer glide.
        if ((2 * body.surplus * slowing) / body.travel - 2 < 1.05) {
          slowing = (3.05 * body.travel) / (2 * body.surplus);
        }
        body.slowing = slowing;
        body.shape = (2 * body.surplus * slowing) / body.travel - 2;
        body.settleAt = body.pass + slowing;
        duration = Math.max(duration, body.settleAt);
      });
  }

  return {
    width,
    height,
    cx: width / 2,
    cy: height / 2,
    radii,
    bodies,
    people: Math.max(0, Math.floor(people)),
    faceRadius,
    planetSize: phone ? PLANET_SIZE.phone : PLANET_SIZE.desktop,
    duration,
  };
}

function project(scene: Scene, angle: number, radius: number): Pose {
  return {
    x: scene.cx + Math.cos(angle) * radius,
    y: scene.cy + Math.sin(angle) * radius * TILT,
    depth: (Math.sin(angle) + 1) / 2,
  };
}

/** Where a body is at time `t` (seconds since the scene started). */
export function poseAt(scene: Scene, body: SceneBody, t: number): Pose {
  if (t < body.pass) {
    const u = Math.max(0, (t - body.start) / APPROACH_SECONDS);
    const anomaly = 2 * Math.atan(barker(-FALL * (1 - u)));
    const radius = (2 * body.passRadius) / (1 + Math.cos(anomaly));
    return project(scene, body.passAngle + anomaly, radius);
  }
  const s = (t - body.pass) / body.slowing;
  const angle =
    body.passAngle +
    body.restSpeed * (t - body.pass) +
    (s >= 1 ? body.travel : body.surplus * body.slowing * slowed(s, body.shape));
  const radius = body.passRadius + (body.radius - body.passRadius) * smooth(s);
  return project(scene, angle, radius);
}

/** How many people the headline says at time `t`: 0 before anyone settles, exact at the end. */
export function countAt(scene: Scene, t: number): number {
  const total = scene.bodies.length;
  if (!total) return scene.people;
  const settled = scene.bodies.filter((b) => b.settleAt <= t).length;
  return settled === total ? scene.people : Math.floor((settled * scene.people) / total);
}

/**
 * How far a face has turned from initials into its photo at time `t`: 0 to 1.
 *
 * It waits for both things — the face having settled into its place, and the photo having
 * arrived (`readyAt`, on the scene's clock; null while it hasn't) — so a face flies in as its
 * initials and becomes the person once it is still enough to see.
 */
export function photoReveal(t: number, settleAt: number, readyAt: number | null): number {
  if (readyAt === null) return 0;
  return smooth((t - Math.max(settleAt, readyAt)) / PHOTO_REVEAL_SECONDS);
}

/** The planet's size multiplier at time `t`. */
export function breathAt(t: number): number {
  return 1 + BREATH.amplitude * Math.sin((TAU * t) / BREATH.seconds);
}

/** Nearer bodies are drawn larger and more opaque. */
export function depthScale(depth: number): number {
  return 0.62 + 0.5 * depth;
}
export function depthAlpha(depth: number): number {
  return 0.5 + 0.5 * depth;
}
