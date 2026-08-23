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

/**
 * Clockwise tilt of the whole figure about the viewBox centre. Baked into the
 * coordinates rather than applied as an SVG transform, because the star name
 * labels are HTML positioned off these same numbers — a transform on the <svg>
 * would leave the labels behind.
 */
const TILT_DEG = 8;

const TILT_COS = Math.cos((TILT_DEG * Math.PI) / 180);
const TILT_SIN = Math.sin((TILT_DEG * Math.PI) / 180);
const CX = DIPPER_VIEW.w / 2;
const CY = DIPPER_VIEW.h / 2;

/** Clockwise in SVG's y-down space. */
function tilt(x: number, y: number): [number, number] {
  const dx = x - CX;
  const dy = y - CY;
  return [
    CX + dx * TILT_COS - dy * TILT_SIN,
    CY + dx * TILT_SIN + dy * TILT_COS,
  ];
}

/** Radii track apparent magnitude — Megrez really is the faint one. */
export const DIPPER_STARS: DipperStar[] = (
  [
    { id: "dubhe", x: 249.4, y: 50.0, r: 3.3 },
    { id: "merak", x: 252.0, y: 101.8, r: 2.7 },
    { id: "phecda", x: 181.7, y: 127.7, r: 2.6 },
    { id: "megrez", x: 152.5, y: 95.5, r: 1.9 },
    { id: "alioth", x: 100.4, y: 105.9, r: 3.4, hotspot: true },
    { id: "mizar", x: 60.0, y: 115.8, r: 2.8 },
    { id: "alkaid", x: 28.0, y: 170.0, r: 3.2 },
  ] as DipperStar[]
).map((star) => {
  const [x, y] = tilt(star.x, star.y);
  return { ...star, x, y };
});

/**
 * Drawn as three segments, all running left to right with the reading
 * direction: the handle comes in from Alkaid, then the bowl opens and closes
 * behind it. (Pen-up between arrays, same convention as the Virgo figure.)
 */
export const DIPPER_CHAINS: string[][] = [
  ["alkaid", "mizar", "alioth", "megrez"],
  ["megrez", "phecda", "merak"],
  ["merak", "dubhe", "megrez"],
];

/**
 * Background field. The first entry is Alcor, Mizar's naked-eye companion —
 * offset a little further than reality so it reads as a separate star at this
 * scale instead of a smudge.
 */
export const DIPPER_FIELD_STARS: Array<[number, number]> = (
  [
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
  ] as Array<[number, number]>
).map(([x, y]) => tilt(x, y));

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
