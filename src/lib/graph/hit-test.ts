/**
 * Turning a tap into a person.
 *
 * A uniform grid over world space, rebuilt only when the layout changes. Chosen over a
 * colour-coded hit canvas because that needs a second full-size backing store — exactly
 * the memory this whole exercise removes — and every `getImageData` forces a GPU→CPU
 * sync that lands as a visible hitch on tap, the one interaction that must feel
 * instant. This is pure arithmetic over typed arrays, and `scripts/smoke-graph-canvas.ts`
 * checks it against a brute-force scan.
 *
 * It doubles as the renderer's frustum cull: `queryRect` is how a frame finds the few
 * hundred stars actually on screen without walking all 3,000.
 */
import type { Vec2, WorldRect } from "@/lib/graph/sky-camera";

export type SkyTargetKind = "contact" | "user" | "nebula" | "clusterLabel";

export type SkyTarget = {
  id: string;
  x: number;
  y: number;
  /** Half-extent used for hit tolerance and for culling. */
  r: number;
  kind: SkyTargetKind;
};

export type SkyGrid = {
  cell: number;
  minX: number;
  minY: number;
  cols: number;
  rows: number;
  /** Target indices per cell, in insertion order. */
  buckets: number[][];
  targets: SkyTarget[];
};

/** Roughly this many cells across the sky, so buckets hold ~1 target each. */
const GRID_DIVISIONS = 48;
const MIN_CELL = 64;
const MAX_CELL = 512;

export function buildSkyGrid(targets: SkyTarget[]): SkyGrid {
  if (targets.length === 0) {
    return { cell: MIN_CELL, minX: 0, minY: 0, cols: 1, rows: 1, buckets: [[]], targets };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of targets) {
    if (t.x < minX) minX = t.x;
    if (t.y < minY) minY = t.y;
    if (t.x > maxX) maxX = t.x;
    if (t.y > maxY) maxY = t.y;
  }

  const span = Math.max(maxX - minX, maxY - minY, 1);
  const cell = Math.min(MAX_CELL, Math.max(MIN_CELL, span / GRID_DIVISIONS));
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const rows = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);

  const buckets: number[][] = Array.from({ length: cols * rows }, () => []);
  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i];
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((t.x - minX) / cell)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((t.y - minY) / cell)));
    buckets[cy * cols + cx].push(i);
  }

  return { cell, minX, minY, cols, rows, buckets, targets };
}

function forEachCellInRange(
  grid: SkyGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  visit: (index: number) => void
) {
  const cx0 = Math.max(0, Math.floor((x0 - grid.minX) / grid.cell));
  const cy0 = Math.max(0, Math.floor((y0 - grid.minY) / grid.cell));
  const cx1 = Math.min(grid.cols - 1, Math.floor((x1 - grid.minX) / grid.cell));
  const cy1 = Math.min(grid.rows - 1, Math.floor((y1 - grid.minY) / grid.cell));

  for (let cy = cy0; cy <= cy1; cy += 1) {
    const row = cy * grid.cols;
    for (let cx = cx0; cx <= cx1; cx += 1) {
      for (const index of grid.buckets[row + cx]) visit(index);
    }
  }
}

/**
 * The nearest target whose disc the point falls within, or null.
 *
 * **Nearest centre, never first-hit.** The layout guarantees only 18 world units
 * between stars, so at the default framing (k ≈ 0.11) a 22px finger spans ~200 world
 * units and many stars are candidates. First-hit would make the answer depend on
 * bucket order — the same tap resolving differently after an unrelated layout change.
 */
export function hitTest(
  grid: SkyGrid,
  point: Vec2,
  toleranceWorld: number,
  filter?: (target: SkyTarget) => boolean
): SkyTarget | null {
  let best: SkyTarget | null = null;
  let bestDistance = Infinity;

  forEachCellInRange(
    grid,
    point.x - toleranceWorld,
    point.y - toleranceWorld,
    point.x + toleranceWorld,
    point.y + toleranceWorld,
    (index) => {
      const t = grid.targets[index];
      if (filter && !filter(t)) return;
      const dx = t.x - point.x;
      const dy = t.y - point.y;
      const distance = Math.hypot(dx, dy);
      if (distance > t.r + toleranceWorld) return;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = t;
      }
    }
  );

  return best;
}

/**
 * Every target that may intersect `rect`. May over-include (a target is tested by its
 * cell, not its exact disc); it must never under-include, or stars pop in at the pane
 * edge as you pan.
 */
export function queryRect(grid: SkyGrid, rect: WorldRect): SkyTarget[] {
  const found: SkyTarget[] = [];
  // Widen by the largest half-extent so a big nebula centred off-screen still draws.
  let maxR = 0;
  for (const t of grid.targets) if (t.r > maxR) maxR = t.r;

  forEachCellInRange(
    grid,
    rect.minX - maxR,
    rect.minY - maxR,
    rect.maxX + maxR,
    rect.maxY + maxR,
    (index) => {
      const t = grid.targets[index];
      if (
        t.x + t.r < rect.minX ||
        t.x - t.r > rect.maxX ||
        t.y + t.r < rect.minY ||
        t.y - t.r > rect.maxY
      ) {
        return;
      }
      found.push(t);
    }
  );

  return found;
}
