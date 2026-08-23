/**
 * The Big Dipper (the Ursa Major asterism), projected from J2000 RA/Dec with
 * RA increasing to the left and scaled by cos(dec) — standard sky-chart
 * orientation, same convention as the Virgo figure, so the bowl sits to the
 * right and the handle sweeps down to the left, keeping its real proportions.
 * Landing constellation scene only — the onboarding graph preview still uses
 * the Virgo figure in src/lib/virgo-figure.ts.
 * ViewBox: 0 0 280 220.
 */

export type DipperStar = {
  id: string;
  x: number;
  y: number;
  r: number;
  /** The brightest star in the figure, rendered a shade whiter. */
  hotspot?: boolean;
};

export const DIPPER_VIEW = { w: 280, h: 220 };

/** Radii track apparent magnitude — Megrez really is the faint one. */
export const DIPPER_STARS: DipperStar[] = [
  { id: "dubhe", x: 249.4, y: 50.0, r: 3.3 },
  { id: "merak", x: 252.0, y: 101.8, r: 2.7 },
  { id: "phecda", x: 181.7, y: 127.7, r: 2.6 },
  { id: "megrez", x: 152.5, y: 95.5, r: 1.9 },
  { id: "alioth", x: 100.4, y: 105.9, r: 3.4, hotspot: true },
  { id: "mizar", x: 60.0, y: 115.8, r: 2.8 },
  { id: "alkaid", x: 28.0, y: 170.0, r: 3.2 },
];

/**
 * Drawn as three segments so the figure builds in a readable order: the bowl
 * opens, the bowl closes, then the handle runs out to Alkaid. (Pen-up between
 * arrays, same convention as the Virgo figure.)
 */
export const DIPPER_CHAINS: string[][] = [
  ["dubhe", "merak", "phecda"],
  ["phecda", "megrez", "dubhe"],
  ["megrez", "alioth", "mizar", "alkaid"],
];

/**
 * Background field. The first entry is Alcor, Mizar's naked-eye companion —
 * offset a little further than reality so it reads as a separate star at this
 * scale instead of a smudge.
 */
export const DIPPER_FIELD_STARS: Array<[number, number]> = [
  [53, 108],
  [216, 38],
  [168, 62],
  [210, 178],
  [128, 168],
  [84, 46],
  [38, 62],
  [114, 30],
  [76, 186],
  [242, 148],
];

const byId = Object.fromEntries(DIPPER_STARS.map((s) => [s.id, s]));

/** SVG path ("M … L …") for one chain, for pathLength-based line draws. */
export function dipperChainPath(chain: string[]): string {
  return chain
    .map((id, i) => {
      const s = byId[id]!;
      return `${i === 0 ? "M" : "L"} ${s.x} ${s.y}`;
    })
    .join(" ");
}

/**
 * One continuous walk that covers every edge exactly once (an Eulerian path —
 * Megrez and Alkaid are the only odd-degree stars, so it has to start at one
 * of them). Used for the shimmer: a single subpath keeps one dash travelling
 * the whole figure, where a multi-subpath `d` would restart the dash pattern
 * on each segment and fire three shimmers at once.
 */
export const DIPPER_SHIMMER_CHAIN = [
  "megrez",
  "dubhe",
  "merak",
  "phecda",
  "megrez",
  "alioth",
  "mizar",
  "alkaid",
];

export const DIPPER_SHIMMER_PATH = dipperChainPath(DIPPER_SHIMMER_CHAIN);

/** Length of that walk in viewBox units, for stroke-dash math. */
export const DIPPER_SHIMMER_LENGTH = DIPPER_SHIMMER_CHAIN.reduce(
  (total, id, i) => {
    if (i === 0) return total;
    const a = byId[DIPPER_SHIMMER_CHAIN[i - 1]!]!;
    const b = byId[id]!;
    return total + Math.hypot(b.x - a.x, b.y - a.y);
  },
  0
);
