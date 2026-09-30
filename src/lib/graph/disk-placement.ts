/**
 * Where each constellation's footprint disk sits in the galaxy.
 *
 * Three passes, all deterministic (seeded hashes, fixed iteration counts, stable order):
 *   1. SEED — biggest first, each cluster followed at once by its closest relatives (its top few
 *      links, and every strong link), while the sky beside it is still open. A cluster with an
 *      already-placed relative goes tangent to the strongest one, at the free angle nearest the
 *      sun; one with none goes to the nearest free ring around the sun, searching from a
 *      running frontier instead of the sun itself. The seed alone is already legal.
 *   2. RELAX — a fixed number of force steps. Affinity edges pull a pair together until their
 *      disks are tangent; overlapping disks push apart; a pull toward the sun, stronger for
 *      bigger clusters, makes the galaxy dense in the middle; the sun's clear zone repels.
 *   3. LEGALIZE — the same visiting order as the seed. A cluster keeps its relaxed spot if it is
 *      free; otherwise it takes the nearest free one, or a spot tangent to its strongest
 *      already-settled relative when that is closer to it. This is what makes non-overlap a
 *      guarantee rather than a hope: it cannot fail, because the search always ends at a spot
 *      beyond everything placed so far.
 *
 * It is a generator so the caller can hand the main thread back every few iterations — the
 * whole layout is one long task otherwise (see `buildHybridGraphLayoutSteps`).
 *
 * Pure geometry on plain data: it knows nothing about contacts, clusters or React.
 */

import type { AffinityEdge } from "@/lib/constellation-affinity";
import { hashUnit } from "@/lib/hash";

export type DiskInput = { id: string; foot: number; size: number };
export type DiskPlacement = {
  centers: Map<string, { x: number; y: number }>;
  /** Outermost reach of any disk from the sun: the galaxy's edge. */
  diskRadius: number;
};
export type DiskOptions = {
  /** No disk may reach inside this radius of the sun. */
  sunClear: number;
  /** Clear space kept between two disks, edge to edge. */
  gap: number;
  iterations?: number;
};

export const DISK_ITERATIONS = 20;
const YIELD_EVERY = 10;
/** Fraction of a link's slack closed per step (each end moves half). */
const ATTRACT = 0.3;
/** Each end of an overlapping pair moves this fraction of the overlap. */
const REPEL = 0.5;
/** Per-step pull toward the sun, as a fraction of distance, at the biggest cluster's weight. */
const GRAVITY = 0.015;
/** Strongest partners seated straight after a cluster, while its surroundings are free. */
const SEED_PARTNERS = 3;
/**
 * A link at least this heavy is seated with its cluster however many stronger links it has.
 * 1 is a company-family link (`AFFINITY.family`): a family must stay together even when a
 * cluster's school and tag links outweigh it.
 */
const STRONG_LINK = 1;
const MAX_STEP = 80;
const SEARCH_STEP = 24;
/** A disk's search rings are also at least this fraction of its footprint apart. */
const SEARCH_STEP_FOOT = 0.3;
/** Seed and legalize yield after this many visited clusters. */
const YIELD_CLUSTERS_EVERY = 20;
const SEARCH_ANGLES = 24;
const SEARCH_RINGS = 600;

/** Disks bucketed by the grid cells their bounding box covers, so a test looks at neighbours. */
class DiskGrid {
  private cells = new Map<number, number[]>();

  constructor(
    private readonly cell: number,
    private readonly count: number
  ) {}

  private key(cx: number, cy: number) {
    return (cx + 100000) * 200003 + (cy + 100000);
  }

  clear() {
    this.cells.clear();
  }

  add(i: number, x: number, y: number, r: number) {
    const x0 = Math.floor((x - r) / this.cell);
    const x1 = Math.floor((x + r) / this.cell);
    const y0 = Math.floor((y - r) / this.cell);
    const y1 = Math.floor((y + r) / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy);
        const list = this.cells.get(k);
        if (list) list.push(i);
        else this.cells.set(k, [i]);
      }
    }
  }

  private stamp = new Int32Array(0);
  private epoch = 0;
  /** Reused by every query: the result is only valid until the next call. */
  private readonly out: number[] = [];

  /** Every disk whose box could overlap the query circle (a superset of the true overlaps).
   * The returned array is shared and overwritten by the next call. */
  near(x: number, y: number, r: number): number[] {
    // A stamp per disk instead of a Set: this runs for every candidate spot of every search.
    if (this.stamp.length < this.count) this.stamp = new Int32Array(this.count * 2);
    const epoch = ++this.epoch;
    const out = this.out;
    out.length = 0;
    const x0 = Math.floor((x - r) / this.cell);
    const x1 = Math.floor((x + r) / this.cell);
    const y0 = Math.floor((y - r) / this.cell);
    const y1 = Math.floor((y + r) / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.cells.get(this.key(cx, cy));
        if (!list) continue;
        for (const j of list) {
          if (this.stamp[j] === epoch) continue;
          this.stamp[j] = epoch;
          out.push(j);
        }
      }
    }
    return out;
  }
}

export function* placeClusterDisks(
  inputs: DiskInput[],
  affinity: AffinityEdge[],
  options: DiskOptions
): Generator<void, DiskPlacement, void> {
  const { sunClear, gap } = options;
  const iterations = options.iterations ?? DISK_ITERATIONS;
  const order = [...inputs].sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));
  const n = order.length;
  const centers = new Map<string, { x: number; y: number }>();
  if (n === 0) return { centers, diskRadius: 0 };

  const index = new Map(order.map((d, i) => [d.id, i]));
  const foot = order.map((d) => d.foot);
  const size = order.map((d) => d.size);
  const maxSize = Math.max(1, size[0]);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const links: Array<Array<{ j: number; w: number }>> = order.map(() => []);
  for (const e of affinity) {
    const i = index.get(e.a);
    const j = index.get(e.b);
    if (i === undefined || j === undefined || i === j) continue;
    links[i].push({ j, w: e.weight });
    links[j].push({ j: i, w: e.weight });
  }
  // Forces are summed link by link, and float addition is not associative: a fixed order is
  // what makes the result independent of the order the affinity list arrived in.
  for (const list of links) list.sort((p, q) => p.j - q.j || p.w - q.w);

  const meanFoot = foot.reduce((s, f) => s + f, 0) / n;
  const grid = new DiskGrid(Math.min(900, Math.max(160, meanFoot * 2)), n);
  let extent = 0;

  const place = (i: number, x: number, y: number) => {
    xs[i] = x;
    ys[i] = y;
    grid.add(i, x, y, foot[i]);
    extent = Math.max(extent, Math.hypot(x, y) + foot[i]);
  };

  /** Free of the sun's clear zone and of every disk in the grid. */
  const free = (x: number, y: number, r: number) => {
    if (Math.hypot(x, y) < sunClear + r) return false;
    for (const j of grid.near(x, y, r + gap)) {
      if (Math.hypot(x - xs[j], y - ys[j]) < foot[j] + r + gap) return false;
    }
    return true;
  };

  /**
   * The free spot for disk `i` nearest the sun, searching outward from (bx, by) in rings of
   * growing distance. Ends at a spot beyond everything placed, so it always finds one.
   */
  const findSpot = (i: number, bx: number, by: number, minDist: number) => {
    const r = foot[i];
    const start = hashUnit(order[i].id, 21) * Math.PI * 2;
    const step = Math.max(SEARCH_STEP, r * SEARCH_STEP_FOOT);
    for (let ring = 0; ring < SEARCH_RINGS; ring++) {
      const d = minDist + ring * step;
      let best: { x: number; y: number; dist: number } | null = null;
      for (let k = 0; k < SEARCH_ANGLES; k++) {
        const t = start + (k / SEARCH_ANGLES) * Math.PI * 2;
        const x = bx + Math.cos(t) * d;
        const y = by + Math.sin(t) * d;
        const dist = Math.hypot(x, y);
        if ((!best || dist < best.dist - 1e-9) && free(x, y, r)) best = { x, y, dist };
      }
      if (best) return best;
    }
    const d = Math.max(extent, sunClear) + r + gap;
    return { x: Math.cos(start) * d, y: Math.sin(start) * d, dist: d };
  };

  // 1. Seed. A cluster's strongest unplaced partners are seated right after it, before the
  // next unrelated cluster: in size order alone, a big cluster's surroundings fill with
  // strangers and its one small relative lands a ring away.
  const placedFlag = new Array<boolean>(n).fill(false);
  /** The strongest link of `i` to a cluster already placed, or -1. */
  const strongestPlaced = (i: number) => {
    let best = -1;
    let bestW = 0;
    for (const { j, w } of links[i]) {
      if (placedFlag[j] && (w > bestW || (w === bestW && j < best))) {
        best = j;
        bestW = w;
      }
    }
    return best;
  };
  /** Visit clusters biggest first, each followed by its closest unvisited relatives. */
  function* visit(one: (i: number) => void) {
    let visited = 0;
    for (let i = 0; i < n; i++) {
      if (placedFlag[i]) continue;
      one(i);
      const partners = links[i]
        .filter(({ j }) => !placedFlag[j])
        .sort((p, q) => q.w - p.w || p.j - q.j)
        .filter(({ w }, rank) => rank < SEED_PARTNERS || w >= STRONG_LINK);
      for (const { j } of partners) if (!placedFlag[j]) one(j);
      if (visited++ % YIELD_CLUSTERS_EVERY === YIELD_CLUSTERS_EVERY - 1) yield;
    }
  }
  // How far out the last unattached cluster had to go: the next one starts its search near
  // there instead of walking every ring from the sun again. Sparse holes it skips stay empty.
  let frontier = 0;
  const seat = (i: number) => {
    const anchor = strongestPlaced(i);
    const spot =
      anchor >= 0
        ? findSpot(i, xs[anchor], ys[anchor], foot[anchor] + foot[i] + gap)
        : findSpot(i, 0, 0, Math.max(sunClear + foot[i], frontier - 2 * (foot[i] + gap)));
    if (anchor < 0) frontier = Math.max(frontier, spot.dist);
    place(i, spot.x, spot.y);
    placedFlag[i] = true;
  };
  yield* visit(seat);
  yield;

  // 2. Relax.
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let step = 0; step < iterations; step++) {
    grid.clear();
    for (let i = 0; i < n; i++) grid.add(i, xs[i], ys[i], foot[i]);
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      const xi = xs[i];
      const yi = ys[i];
      for (const { j, w } of links[i]) {
        const ex = xs[j] - xi;
        const ey = ys[j] - yi;
        const d = Math.hypot(ex, ey);
        const want = foot[i] + foot[j] + gap;
        if (d > want) {
          const pull = (d - want) * ATTRACT * Math.min(1, w) * 0.5;
          dx[i] += (ex / d) * pull;
          dy[i] += (ey / d) * pull;
        }
      }
      const r = Math.hypot(xi, yi);
      if (r > 1e-6) {
        const g = GRAVITY * Math.sqrt(size[i] / maxSize) * r;
        dx[i] -= (xi / r) * g;
        dy[i] -= (yi / r) * g;
      }
      for (const j of grid.near(xi, yi, foot[i] + gap)) {
        if (j === i) continue;
        let ex = xi - xs[j];
        let ey = yi - ys[j];
        let d = Math.hypot(ex, ey);
        const min = foot[i] + foot[j] + gap;
        if (d >= min) continue;
        if (d < 1e-6) {
          const t = hashUnit(order[i].id, 33) * Math.PI * 2;
          ex = Math.cos(t);
          ey = Math.sin(t);
          d = 1;
        }
        const push = (min - d) * REPEL;
        dx[i] += (ex / d) * push;
        dy[i] += (ey / d) * push;
      }
      if (r < sunClear + foot[i]) {
        const out = sunClear + foot[i] - r;
        if (r > 1e-6) {
          dx[i] += (xi / r) * out;
          dy[i] += (yi / r) * out;
        } else {
          dx[i] += out;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      let mx = dx[i];
      let my = dy[i];
      const m = Math.hypot(mx, my);
      if (m > MAX_STEP) {
        mx = (mx / m) * MAX_STEP;
        my = (my / m) * MAX_STEP;
      }
      xs[i] += mx;
      ys[i] += my;
    }
    if (step % YIELD_EVERY === YIELD_EVERY - 1) yield;
  }

  // 3. Legalize. Same order as the seed: a cluster's closest relatives are settled right after
  // it, while the sky beside it is still open.
  grid.clear();
  extent = 0;
  placedFlag.fill(false);
  const settle = (i: number) => {
    placedFlag[i] = true;
    if (free(xs[i], ys[i], foot[i])) {
      place(i, xs[i], ys[i]);
      return;
    }
    // Nearest free spot to where relaxing left it — unless a relative is already settled and
    // a spot tangent to it is closer to it than this one is.
    let spot = findSpot(i, xs[i], ys[i], 0);
    const kin = strongestPlaced(i);
    if (kin >= 0) {
      const tangent = findSpot(i, xs[kin], ys[kin], foot[kin] + foot[i] + gap);
      const away = (p: { x: number; y: number }) => Math.hypot(p.x - xs[kin], p.y - ys[kin]);
      if (away(tangent) < away(spot)) spot = tangent;
    }
    place(i, spot.x, spot.y);
  };
  yield* visit(settle);

  let diskRadius = 0;
  for (let i = 0; i < n; i++) {
    centers.set(order[i].id, { x: xs[i], y: ys[i] });
    diskRadius = Math.max(diskRadius, Math.hypot(xs[i], ys[i]) + foot[i]);
  }
  return { centers, diskRadius };
}
