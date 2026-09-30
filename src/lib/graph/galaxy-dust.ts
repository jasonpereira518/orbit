/**
 * The galaxy backdrop's raw material: where the dust sits, and which dark lanes cross it.
 *
 * `galaxy-structure.ts` says WHICH relatedness chains to trace (filaments, each a bowed 6-point
 * path between two clusters). This turns each into a soft band of dust — denser along stronger
 * links — plus a few dark lanes over the strongest. Pure numbers, so the desktop worker and the
 * mobile bake draw the same sky from the same data.
 */

import type { GalaxyStructure } from "@/lib/graph/galaxy-structure";
import { hashUnit } from "@/lib/hash";

export type GalaxyLane = { path: Array<{ x: number; y: number }>; width: number; alpha: number };
export type GalaxyDust = { x: number[]; y: number[]; alpha: number[]; radius: number[]; lanes: GalaxyLane[] };
export type GalaxyBackdropData = {
  kind: "galaxyBackdrop";
  coreRadius: number;
  diskRadius: number;
  dust: GalaxyDust;
  /** World-space box the bitmap covers: a square about the sun. */
  minX: number;
  minY: number;
  width: number;
  height: number;
};

const LANES = 14;
const DUST_MIN = 14;
const DUST_MAX = 70;
const BOX_MARGIN = 1.15;
const MIN_HALF = 400;

/** The point `t` (0–1) along a polyline, with the normal of the segment it falls on. */
function along(path: Array<{ x: number; y: number }>, lengths: number[], total: number, t: number) {
  let d = t * total;
  for (let i = 0; i < lengths.length; i++) {
    if (d <= lengths[i] || i === lengths.length - 1) {
      const u = lengths[i] > 0 ? Math.min(1, d / lengths[i]) : 0;
      const a = path[i];
      const b = path[i + 1];
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, nx: -(b.y - a.y) / (lengths[i] || 1), ny: (b.x - a.x) / (lengths[i] || 1) };
    }
    d -= lengths[i];
  }
  const last = path[path.length - 1];
  return { x: last.x, y: last.y, nx: 0, ny: 1 };
}

export function galaxyBackdropData(galaxy: GalaxyStructure): GalaxyBackdropData {
  const half = Math.max(galaxy.diskRadius * BOX_MARGIN, galaxy.coreRadius * 2, MIN_HALF);
  const dust: GalaxyDust = { x: [], y: [], alpha: [], radius: [], lanes: [] };

  // Weight first, then the pair's names: the order the filaments arrive in must change nothing,
  // neither which lanes are kept nor where in the arrays a dot lands.
  const ordered = [...galaxy.filaments].sort(
    (a, b) =>
      b.weight - a.weight ||
      (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
      (a.to < b.to ? -1 : a.to > b.to ? 1 : 0)
  );

  for (const f of ordered) {
    if (f.path.length < 2) continue;
    const lengths = f.path.slice(1).map((p, i) => Math.hypot(p.x - f.path[i].x, p.y - f.path[i].y));
    const total = lengths.reduce((s, l) => s + l, 0);
    if (total <= 0) continue;
    const strength = 0.6 + Math.min(f.weight, 1.5);
    const count = Math.max(DUST_MIN, Math.min(DUST_MAX, Math.round((total / 45) * strength)));
    const spread = 10 + total * 0.05;
    const seed = `${f.from}|${f.to}`;
    for (let k = 0; k < count; k++) {
      const p = along(f.path, lengths, total, (k + hashUnit(seed, k * 4)) / count);
      // Two draws averaged: a soft band, densest on the filament's own line.
      const off = (hashUnit(seed, k * 4 + 1) + hashUnit(seed, k * 4 + 2) - 1) * spread;
      dust.x.push(Math.max(-half, Math.min(half, p.x + p.nx * off)));
      dust.y.push(Math.max(-half, Math.min(half, p.y + p.ny * off)));
      dust.alpha.push(0.05 + 0.17 * hashUnit(seed, k * 4 + 3) * Math.min(1, 0.4 + f.weight));
      dust.radius.push(2 + 5 * hashUnit(seed, k * 4 + 1000));
    }
  }

  ordered
    .slice(0, LANES)
    .forEach((f) => {
      const seed = `${f.from}|${f.to}`;
      dust.lanes.push({
        path: f.path,
        width: 18 + 24 * hashUnit(seed, 5000),
        alpha: 0.16 + 0.14 * hashUnit(seed, 5001),
      });
    });

  return { kind: "galaxyBackdrop", coreRadius: galaxy.coreRadius, diskRadius: galaxy.diskRadius, dust, minX: -half, minY: -half, width: half * 2, height: half * 2 };
}

/**
 * The zoom the backdrop's bitmap is drawn at. The backing scale is `min(zoom·dpr, cap/width)`,
 * so once `zoom` reaches `cap/(width·dpr)` the cap binds and the pixels stop changing with the
 * camera. Holding the zoom at that point makes every later zoom step the SAME job, so the node's
 * "already drawn" check skips it: at 10,000 contacts that is one draw ever. Below it the scale
 * still follows the zoom, correctly (a small galaxy's box fits the cap only at high zoom).
 */
export function galaxyBackdropZoom(zoom: number, width: number, dpr: number, maxBackingPx: number) {
  return Math.min(zoom, maxBackingPx / (Math.max(width, 1) * dpr));
}
