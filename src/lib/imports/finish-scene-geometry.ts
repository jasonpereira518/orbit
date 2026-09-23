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
/** A face's drawn radius. The scene draws it; the layout keeps room for it. */
export const FACE_RADIUS = 11;
/** How far a face reaches past its centre: its radius plus the one-pixel ring stroked round it. */
const FACE_REACH = FACE_RADIUS + 1;

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
    const face = i < Math.min(MAX_FACES, count);
    // A dot is a point, but a face is a circle around one: its centre has to sit a whole face
    // inside the edge. On a phone's 120px the outer ring's centre was 51.6 of a 60px half-height,
    // so a face there ran off the bottom. Pulled in only as far as needed, and only for faces —
    // they stay on their own ring, just no further out than the canvas allows.
    const reach = face ? FACE_REACH : 0;
    dots.push({
      ring,
      angle: (i * GOLDEN) % (Math.PI * 2),
      radiusX: Math.min(halfW * RINGS[ring].rx, Math.max(0, halfW - reach)),
      radiusY: Math.min(halfH * RINGS[ring].ry, Math.max(0, halfH - reach)),
      // Faces arrive first so the recognisable part of the scene lands early.
      delay: (i / Math.max(1, count)) * 1.2,
      face,
    });
  }
  return dots;
}

/** Ease-out cubic: fast arrival, gentle landing. */
export function settle(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}
