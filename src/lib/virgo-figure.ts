/**
 * Virgo stick figure from the IAU constellation lines, projected from
 * J2000 RA/Dec (RA increases left, Dec up — standard sky-chart orientation).
 * Shared by the onboarding graph preview and the landing constellation scene.
 * ViewBox: 0 0 280 220.
 */

export type VirgoStar = {
  id: string;
  x: number;
  y: number;
  r: number;
  hotspot?: "spica";
};

export const VIRGO_VIEW = { w: 280, h: 220 };

export const VIRGO_STARS: VirgoStar[] = [
  { id: "vir109", x: 28.0, y: 89.1, r: 2.0 },
  { id: "mu", x: 31.8, y: 140.0, r: 2.1 },
  { id: "iota", x: 65.5, y: 142.3, r: 1.9 },
  { id: "kappa", x: 69.3, y: 171.1, r: 1.8 },
  { id: "lambda", x: 61.6, y: 192.0, r: 1.6 },
  { id: "zeta", x: 116.7, y: 105.9, r: 2.4 },
  { id: "spica", x: 128.5, y: 177.1, r: 4.4, hotspot: "spica" },
  { id: "eps", x: 157.1, y: 28.0, r: 2.9 },
  { id: "delta", x: 165.3, y: 79.0, r: 2.5 },
  { id: "gamma", x: 182.5, y: 111.7, r: 3.1 },
  { id: "eta", x: 209.6, y: 106.4, r: 2.2 },
  { id: "omi", x: 227.8, y: 43.0, r: 1.9 },
  { id: "beta", x: 245.8, y: 89.9, r: 2.3 },
  { id: "nu", x: 252.0, y: 57.9, r: 1.8 },
];

/** IAU Virgo stick-figure segments (pen-up between arrays). */
export const VIRGO_CHAINS: string[][] = [
  ["vir109", "mu", "iota", "kappa", "lambda"],
  ["iota", "gamma", "eta", "beta", "nu", "omi", "eta"],
  ["eps", "delta", "gamma", "zeta", "spica"],
];

export const VIRGO_FIELD_STARS: Array<[number, number]> = [
  [48, 52],
  [92, 34],
  [110, 168],
  [148, 148],
  [198, 62],
  [220, 168],
  [248, 132],
  [42, 108],
  [176, 198],
];

const byId = Object.fromEntries(VIRGO_STARS.map((s) => [s.id, s]));

/** SVG path ("M … L …") for one chain, for pathLength-based line draws. */
export function virgoChainPath(chain: string[]): string {
  return chain
    .map((id, i) => {
      const s = byId[id]!;
      return `${i === 0 ? "M" : "L"} ${s.x} ${s.y}`;
    })
    .join(" ");
}

export function virgoStar(id: string): VirgoStar {
  return byId[id]!;
}
