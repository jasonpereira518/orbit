/**
 * The Orbit mark's constellation, as geometry.
 *
 * `public/orbit-logo.png` is a 512px raster and the only form the mark exists
 * in — there is no SVG anywhere in the repo. The celebration needs the mark as
 * *data* rather than as an image: it forges the asterism star by star, engraves
 * it into a struck medallion, and anchors orbiting perks to real node
 * positions. None of that is possible with a flat sprite.
 *
 * Positions are traced from the PNG and expressed in unit space around the
 * DISC's centre, not the canvas centre — the painted disc sits ~10.5px right of
 * centre on the 512px source (the same offset `orbit-logo.tsx` corrects for
 * with `MARK_SHIFT_RATIO`). Unit radius 1 is the disc's edge.
 *
 * Exact pixel parity with the PNG is not the goal and never was: the medallion
 * is the mark struck in metal, not a copy of the sprite. Recognisability of the
 * asterism is what carries the identity.
 */

export type MarkNode = {
  x: number;
  y: number;
  /** Relative node weight; the brightest star in the mark is the largest. */
  size: number;
  /** Round nodes are the asterism's stars; sparks are its four-pointed ones. */
  kind: "disc" | "spark";
};

/**
 * The dipper, handle-first. Order is the forge order — the constellation
 * strikes in from the handle's tip and closes the bowl last, so the shape
 * resolves in the direction a reader's eye already travels.
 */
export const MARK_NODES: MarkNode[] = [
  { x: -0.92, y: -0.155, size: 0.85, kind: "disc" }, // handle tip, at the rim
  { x: -0.582, y: -0.229, size: 1.05, kind: "disc" },
  { x: -0.231, y: -0.098, size: 1.15, kind: "spark" }, // the large four-pointed star
  { x: 0.096, y: 0.024, size: 1.0, kind: "disc" }, // bowl's inner corner
  { x: 0.259, y: 0.363, size: 0.95, kind: "disc" },
  { x: 0.741, y: 0.282, size: 1.0, kind: "disc" },
  { x: 0.782, y: -0.18, size: 1.3, kind: "disc" }, // brightest, white-cored
];

/**
 * Index pairs into `MARK_NODES`. The last edge closes the bowl back onto the
 * handle joint, which is what makes the shape read as a dipper rather than as
 * an open zigzag.
 */
export const MARK_EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [6, 3],
];

/**
 * Decorative field stars scattered across the disc face, matching the small
 * sparkles in the mark. Engraved shallow — they read as texture, and they stop
 * the medallion's face from going flat between the asterism's arms.
 */
export const MARK_FIELD: readonly { x: number; y: number; size: number }[] = [
  { x: -0.63, y: 0.28, size: 0.4 },
  { x: -0.42, y: 0.55, size: 0.55 },
  { x: -0.72, y: -0.5, size: 0.35 },
  { x: 0.1, y: -0.55, size: 0.42 },
  { x: 0.02, y: 0.5, size: 0.34 },
  { x: 0.36, y: 0.62, size: 0.3 },
  { x: 0.62, y: -0.62, size: 0.5 },
];
