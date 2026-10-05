/**
 * The dimensions of the chat activity orbit, kept apart from the component so the one rule
 * that matters can be tested: no two faces may ever touch.
 *
 * That rule is not a still-frame property. The two rings turn in opposite directions, so a
 * face on one ring passes every face on the other, and at the moment they line up the gap
 * between them is exactly the radial distance between the rings. If that is smaller than a
 * face, faces overlap on every pass — not just in one unlucky screenshot.
 */

export type OrbitRing = {
  radius: number;
  capacity: number;
  /** Degrees to rotate the first slot by, so the two rings do not line up like spokes. */
  offset: number;
  duration: string;
  /** The ring's direction; its riders go the other way. */
  direction: "normal" | "reverse";
};

/** Diameter of one face, in px. */
export const ORBIT_FACE = 26;

// Inner first: the earliest people sit closest to the planet.
export const ORBIT_RINGS: readonly OrbitRing[] = [
  { radius: 34, capacity: 3, offset: 30, duration: "26s", direction: "normal" },
  { radius: 62, capacity: 5, offset: 12, duration: "40s", direction: "reverse" },
];

/** Square side of the scene: the outermost face's far edge, plus a little air for the hover grow. */
export const ORBIT_SIZE = 2 * (Math.max(...ORBIT_RINGS.map((r) => r.radius)) + ORBIT_FACE / 2) + 6;

/**
 * The closest any two faces can ever get, over every phase of both rings.
 *
 * Two faces on one ring are a fixed chord apart. Two on different rings are closest when
 * they line up radially, which the opposite spins guarantee will happen — so that distance
 * is the gap between the rings, whatever the angles.
 */
export function minFaceSeparation(
  rings: readonly OrbitRing[] = ORBIT_RINGS
): number {
  let min = Infinity;
  for (const ring of rings) {
    if (ring.capacity >= 2) {
      // Adjacent slots on a ring: chord = 2 r sin(pi / n).
      min = Math.min(min, 2 * ring.radius * Math.sin(Math.PI / ring.capacity));
    }
  }
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      min = Math.min(min, Math.abs(rings[i].radius - rings[j].radius));
    }
  }
  return min;
}
