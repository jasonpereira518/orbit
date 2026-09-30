/**
 * The galaxy's shape data, for the renderers to draw in a later phase.
 *
 * Nothing here decides where anything sits — `disk-placement.ts` did that. This turns the
 * placement into three things a backdrop needs: how big the bright core is, where the disk
 * fades out, and which relatedness chains to trace with dust. Filaments follow the spanning
 * forest of the affinity graph (every related cluster reaches its neighbours by the strongest
 * route, and no more) plus a few strong cycle-closing links so the dust reads as fragments of
 * arms rather than a bare tree.
 */

import type { AffinityEdge } from "@/lib/constellation-affinity";
import { hashUnit } from "@/lib/hash";

export type GalaxyFilament = {
  from: string;
  to: string;
  weight: number;
  path: Array<{ x: number; y: number }>;
};

export type GalaxyStructure = {
  /** Radius of the warm glow around the sun. */
  coreRadius: number;
  /** Where the disk's haze fades out: the placement's outermost reach. */
  diskRadius: number;
  filaments: GalaxyFilament[];
};

// Code-point order, not locale order: server and browser must agree.
const byId = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

export const FILAMENT_POINTS = 6;
export const MAX_FILAMENTS = 400;
/** How far a filament bows sideways, as a fraction of its length. */
const BOW = 0.12;
const CORE_FRACTION = 0.15;

export function buildGalaxyStructure(
  centers: Map<string, { x: number; y: number }>,
  affinity: AffinityEdge[],
  options: { sunClear: number; diskRadius: number }
): GalaxyStructure {
  const { sunClear, diskRadius } = options;
  const coreRadius = Math.max(sunClear, diskRadius * CORE_FRACTION);

  // Kruskal over the strongest links first (`affinity` arrives sorted; sort again to be safe).
  const links = affinity
    .filter((e) => centers.has(e.a) && centers.has(e.b))
    .sort((x, y) => y.weight - x.weight || byId(x.a, y.a) || byId(x.b, y.b));
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    let cur = id;
    while ((parent.get(cur) ?? cur) !== cur) {
      const up = parent.get(cur)!;
      parent.set(cur, parent.get(up) ?? up);
      cur = up;
    }
    return cur;
  };
  const tree: AffinityEdge[] = [];
  const rest: AffinityEdge[] = [];
  for (const e of links) {
    const ra = root(e.a);
    const rb = root(e.b);
    if (ra === rb) {
      rest.push(e);
    } else {
      parent.set(ra, rb);
      tree.push(e);
    }
  }
  const extras = Math.max(8, Math.round(centers.size * 0.15));
  const chosen = [...tree, ...rest.slice(0, extras)].slice(0, MAX_FILAMENTS);

  const filaments = chosen.map((e) => {
    const a = centers.get(e.a)!;
    const b = centers.get(e.b)!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // A perpendicular unit vector, and a side that stays the same for the same pair.
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const side = hashUnit(`${e.a}|${e.b}`, 31) < 0.5 ? -1 : 1;
    const path: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < FILAMENT_POINTS; i++) {
      const t = i / (FILAMENT_POINTS - 1);
      const bow = Math.sin(Math.PI * t) * len * BOW * side;
      path.push({
        x: Math.round(a.x + (b.x - a.x) * t + nx * bow),
        y: Math.round(a.y + (b.y - a.y) * t + ny * bow),
      });
    }
    return { from: e.a, to: e.b, weight: e.weight, path };
  });

  return { coreRadius, diskRadius, filaments };
}
