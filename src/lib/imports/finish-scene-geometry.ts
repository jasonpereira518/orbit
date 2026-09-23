/**
 * Where the swarm's dots go, with no canvas involved.
 *
 * Bounded on purpose: an import of 3,000 people draws 300 dots and lets the sentence carry the
 * number. The cost of the scene is the same for a huge import as for a middling one, which is
 * what makes it safe to run on a phone.
 */
export const MAX_DOTS = 300;
export const MAX_FACES = 12;
export const SCENE_HEIGHT = { desktop: 180, phone: 120 } as const;

/** Ring radii as a fraction of the canvas half-width / half-height. */
const RINGS = [
  { rx: 0.34, ry: 0.34, share: 0.3 },
  { rx: 0.62, ry: 0.58, share: 0.35 },
  { rx: 0.92, ry: 0.86, share: 0.35 },
] as const;

export type Dot = {
  ring: number;
  angle: number;
  radiusX: number;
  radiusY: number;
  /** Seconds before this dot starts arriving. */
  delay: number;
  face: boolean;
};

export function dotCount(people: number): number {
  return Math.max(0, Math.min(Math.floor(people), MAX_DOTS));
}

export function layoutDots(people: number, width: number, height: number): Dot[] {
  const count = dotCount(people);
  const halfW = width / 2;
  const halfH = height / 2;
  const dots: Dot[] = [];

  // The golden angle keeps successive dots from landing on top of each other without random.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < count; i++) {
    const fraction = count === 1 ? 0 : i / count;
    let ring = RINGS.length - 1;
    let acc = 0;
    for (let r = 0; r < RINGS.length; r++) {
      acc += RINGS[r].share;
      if (fraction < acc) {
        ring = r;
        break;
      }
    }
    dots.push({
      ring,
      angle: (i * GOLDEN) % (Math.PI * 2),
      radiusX: halfW * RINGS[ring].rx,
      radiusY: halfH * RINGS[ring].ry,
      // Faces arrive first so the recognisable part of the scene lands early.
      delay: (i / Math.max(1, count)) * 1.2,
      face: i < Math.min(MAX_FACES, count),
    });
  }
  return dots;
}

/** Ease-out cubic: fast arrival, gentle landing. */
export function settle(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}
