/**
 * "Turn on Radar": the timing and layout of the supercharge scene, kept pure so the smoke
 * can pin them (`scripts/smoke-radar-activation.ts`). The canvas
 * (`src/components/radar/activation/activation-canvas.tsx`) draws every frame from these.
 *
 * Your people sit in three rings around you (Earth), closest first. Every node is a real
 * image: the person's photo, or a planet when they have none. No connecting lines.
 */

/** Beat starts, in ms from the press. */
export const BEAT = {
  press: 0,
  charge: 250,
  ignite: 1300,
  spin: 1700,
  sweep: 2700,
  land: 3600,
  end: 4200,
} as const;

/** The 1s cut a returning person sees: ignition, then the landing. */
export const SHORT_IGNITE_MS = BEAT.spin - BEAT.ignite;
export const SHORT_END_MS = SHORT_IGNITE_MS + (BEAT.end - BEAT.land);

/** Scene time for elapsed wall time. The short cut plays ignition, then jumps to the landing. */
export function sceneTime(elapsed: number, short: boolean): number {
  if (!short) return elapsed;
  return elapsed < SHORT_IGNITE_MS ? BEAT.ignite + elapsed : BEAT.land + (elapsed - SHORT_IGNITE_MS);
}

/** How long a play lasts, full or short. */
export const playLength = (short: boolean) => (short ? SHORT_END_MS : BEAT.end);

/** The planets a person without a photo is drawn as (`public/landing/planets/`). */
export const PLANETS = ["mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune"] as const;
export const planetSrc = (name: string) => `/landing/planets/${name}.webp`;
export const EARTH_SRC = planetSrc("earth");

/** People per ring, inside out. */
export const RING_CAPACITY = [6, 9, 12] as const;
/** Below this many people the scene is drawn with planets only, so it never looks empty. */
export const MIN_REAL_FACES = 3;
const PLACEHOLDER_COUNT = 9;

export type SceneFace = { contactId: string; name: string; photo: string | null };

export type SceneNode = {
  id: string;
  /** 0 = innermost. */
  ring: number;
  /** Resting angle in radians, before the spin. */
  angle: number;
  /** The image to draw: a photo URL or a planet. */
  src: string;
  /** Fallback when the photo fails to load. */
  planet: string;
};

/** FNV-1a: a stable number per id, so the same network always lands in the same places. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function planetFor(id: string): string {
  return planetSrc(PLANETS[hashId(id) % PLANETS.length]);
}

/** Places people into the rings, closest first. A tiny network gets planets instead. */
export function placeNodes(faces: readonly SceneFace[]): SceneNode[] {
  const people: SceneFace[] =
    faces.length >= MIN_REAL_FACES
      ? faces.slice(0, RING_CAPACITY.reduce((a, b) => a + b, 0))
      : Array.from({ length: PLACEHOLDER_COUNT }, (_, i) => ({ contactId: `planet-${i}`, name: "", photo: null }));
  const nodes: SceneNode[] = [];
  let i = 0;
  RING_CAPACITY.forEach((cap, ring) => {
    const members = people.slice(i, i + cap);
    i += cap;
    if (members.length === 0) return;
    // Each ring starts at an angle seeded by its first member, so rings don't line up.
    const offset = ((hashId(members[0].contactId) % 360) * Math.PI) / 180;
    members.forEach((p, k) => {
      const planet = planetFor(p.contactId);
      nodes.push({
        id: p.contactId,
        ring,
        angle: offset + (k / members.length) * Math.PI * 2,
        src: p.photo ?? planet,
        planet,
      });
    });
  });
  return nodes;
}

/**
 * Ring radii and node sizes for a box. The outer ring, its nodes and their ping rings fit
 * inside the shorter side (36px margin), so nothing clips on a 375px phone.
 */
export function ringLayout(w: number, h: number) {
  const outer = Math.max(40, Math.min(w, h * 0.92) / 2 - 36);
  const unit = Math.max(0.55, Math.min(1.2, outer / 300));
  return {
    radii: [outer * 0.4, outer * 0.7, outer],
    nodeRadius: [24 * unit, 18 * unit, 14 * unit],
    earthRadius: 34 * unit,
  };
}

/** Rings orbit from the spin beat on, alternating direction, inner ring fastest. Radians. */
export function ringSpin(t: number, ring: number): number {
  if (t <= BEAT.spin) return 0;
  const dir = ring % 2 === 0 ? 1 : -1;
  const top = [1.4, 1.0, 0.7][ring] ?? 0.7; // rad/s once spun up
  const rampMs = BEAT.sweep - BEAT.spin;
  const dt = t - BEAT.spin;
  const ramped =
    dt < rampMs ? (0.5 * top * dt * dt) / rampMs / 1000 : (0.5 * top * rampMs) / 1000 + (top * (dt - rampMs)) / 1000;
  return dir * ramped;
}

/** Which three nodes the beam pings: spread across the rings, never the same person twice. */
export function pingTargets(nodes: readonly SceneNode[]): number[] {
  if (nodes.length <= 3) return nodes.map((_, i) => i);
  const step = Math.floor(nodes.length / 3);
  return [1, 1 + step, 1 + 2 * step].map((i) => i % nodes.length);
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Progress through [a, b]. */
export const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
export const easeOut = (v: number) => 1 - Math.pow(1 - v, 3);
export const easeIn = (v: number) => v * v * v;
