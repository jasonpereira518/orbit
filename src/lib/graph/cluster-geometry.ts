import { scaleForStarCount, type ConstellationShape } from "@/lib/constellation-shapes";
import type { ClusterFit, FitPart } from "@/lib/constellation-fit";
import type { BuiltCluster } from "@/lib/constellation-clusters";
import { arrangeParts, ringLayout } from "@/lib/graph/cluster-anatomy";
import { hashUnit } from "@/lib/hash";
import { hashUnitStream } from "@/lib/hash-stream";

/**
 * Every star carries an always-visible name + role label (see
 * graph-nodes.tsx), so spacing is driven by label size rather than star
 * size: LABEL_WIDTH horizontally, LABEL_HEIGHT vertically.
 */
export const LABEL_WIDTH = 104;
export const LABEL_HEIGHT = 30;

/** Scatter field starts this far beyond the figure's extent. */
export const SCATTER_CLEAR = 54;
/** Initial width of a cluster's scatter field annulus. */
export const SCATTER_FIELD_WIDTH = 110;
/** Headroom beyond the outermost scatter star inside the footprint. */
export const FOOT_MARGIN = 34;
/** Clear space between two parts of one company (its core and petals), edge to edge. */
export const PART_GAP = 64;
/** Minimum distance between any two figure stars after scaling. */
export const FIGURE_STAR_MIN = LABEL_WIDTH;
/** How far a tight template may be upscaled to clear FIGURE_STAR_MIN. */
export const FIGURE_MAX_UPSCALE = 2.4;

/**
 * Two stars may not sit inside each other's label boxes: they need either
 * horizontal room for a label, or enough vertical room that a label clears
 * the star below it.
 */
export const LABEL_CLEAR_X = LABEL_WIDTH + 8;
export const LABEL_CLEAR_Y = LABEL_HEIGHT + 14;

function labelClear(
  a: { x: number; y: number },
  b: { x: number; y: number }
) {
  return (
    Math.abs(a.x - b.x) >= LABEL_CLEAR_X || Math.abs(a.y - b.y) >= LABEL_CLEAR_Y
  );
}

const GRID_OFFSET = 2 ** 20;
const GRID_STRIDE = 2 ** 21;

/**
 * The placed stars, bucketed so a clearance test looks at neighbours rather than everyone.
 *
 * Cells are exactly one label-clearance box wide and tall. Two stars conflict only when they
 * are closer than LABEL_CLEAR_X horizontally AND LABEL_CLEAR_Y vertically, so any conflict
 * sits in the candidate's cell or one of its eight neighbours — the answer is the same as
 * testing every placed star with `labelClear`, which is what this replaced. That linear scan
 * ran for every candidate of every star, and all of a network's unclustered contacts share
 * one field, so it grew with the square of the network.
 */
export class ClearanceGrid {
  private cells = new Map<number, Array<{ x: number; y: number }>>();

  /**
   * One number per cell rather than a `"cx,cy"` string: the test below looks up nine cells per
   * candidate, and building and hashing those strings was most of the layout's time at 10,000
   * contacts. Exact for |cx|, |cy| < 2^20 cells — over a hundred million world px either way.
   */
  private static key(cx: number, cy: number) {
    return (cx + GRID_OFFSET) * GRID_STRIDE + (cy + GRID_OFFSET);
  }

  add(p: { x: number; y: number }) {
    const k = ClearanceGrid.key(
      Math.floor(p.x / LABEL_CLEAR_X),
      Math.floor(p.y / LABEL_CLEAR_Y)
    );
    const cell = this.cells.get(k);
    if (cell) cell.push(p);
    else this.cells.set(k, [p]);
  }

  /** True when `labelClear(candidate, p)` holds for every star added so far. */
  clear(candidate: { x: number; y: number }) {
    const cx = Math.floor(candidate.x / LABEL_CLEAR_X);
    const cy = Math.floor(candidate.y / LABEL_CLEAR_Y);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.cells.get(ClearanceGrid.key(cx + dx, cy + dy));
        if (!cell) continue;
        for (const p of cell) {
          if (!labelClear(candidate, p)) return false;
        }
      }
    }
    return true;
  }
}

/**
 * Scatter members organically through an annulus — no rings, no lattice.
 * Seeded rejection sampling: each member tries hash-driven spots until one
 * clears every already-placed star's label box; when an annulus fills up it
 * widens and the sampling continues. Deterministic and guaranteed to leave
 * breathing room between nodes.
 */
export function scatterField(
  ids: string[],
  seedPrefix: string,
  inner: number,
  initialWidth: number,
  avoid: Array<{ x: number; y: number }>
): { placed: Array<{ id: string; x: number; y: number }>; outer: number } {
  const placed: Array<{ id: string; x: number; y: number }> = [];
  const occupied = new ClearanceGrid();
  for (const p of avoid) occupied.add(p);
  let outer = inner + initialWidth;

  for (const id of ids) {
    let spot: { x: number; y: number } | null = null;
    let attempt = 0;
    let rounds = 0;
    // The same values as hashUnit(seedPrefix + ":" + id, salt), hashing the string once per star.
    const hash = hashUnitStream(`${seedPrefix}:${id}`);
    while (!spot && rounds < 200) {
      for (let tries = 0; tries < 24 && !spot; tries++, attempt++) {
        const u = hash(attempt * 2 + 1);
        const v = hash(attempt * 2 + 2);
        const angle = u * Math.PI * 2;
        // sqrt() → uniform density over the annulus
        const radius = Math.sqrt(
          inner * inner + v * (outer * outer - inner * inner)
        );
        const candidate = {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        };
        if (occupied.clear(candidate)) {
          spot = candidate;
        }
      }
      if (!spot) {
        outer += 40;
        rounds += 1;
      }
    }
    // Practically unreachable — the annulus grows until a spot clears.
    if (!spot) {
      outer += LABEL_CLEAR_X;
      spot = { x: outer, y: 0 };
    }
    placed.push({ id, ...spot });
    occupied.add(spot);
  }

  const maxR = placed.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.y)), inner);
  return { placed, outer: Math.max(outer, maxR) };
}

/** One part's local geometry: its figure stars plus a scatter field. */
export type PartGeometry = {
  part: FitPart;
  /** Where the part's own origin sits in the cluster's local space. */
  center: { x: number; y: number };
  /** Cluster-local, already offset by `center` (index ↔ part.figureMemberIds). */
  figureLocal: Array<{ x: number; y: number }>;
  scatterLocal: Array<{ id: string; x: number; y: number }>;
  /** The part's own footprint radius about `center`. */
  foot: number;
  /** A ring school only: the ring's outer radius about `center`. */
  ringRadius?: number;
};

/** One cluster's local geometry: its parts and the disk that holds them all. */
export type ClusterGeometry = {
  cluster: BuiltCluster;
  fit: ClusterFit;
  parts: PartGeometry[];
  /** Footprint radius: everything the cluster draws stays inside this disk. */
  foot: number;
};

export type LocalPart = Omit<PartGeometry, "part" | "center">;

/**
 * A figure and its scatter, in the part's own space. The asterism renders at its natural scale
 * with a mild seeded tilt — never warped — and is scaled up only if a template packs two stars
 * closer than FIGURE_STAR_MIN or than their name boxes need. Both adjustments are a single
 * uniform scale, so a figure always stays a pure similarity transform of its template. Overflow
 * members scatter through an annulus fully outside the figure's extent, which guarantees
 * clearance from every figure star and line by construction.
 */
export function figureGeometry(
  shape: ConstellationShape,
  figureMemberIds: string[],
  scatterIds: string[],
  seed: string
): LocalPart {
  const count = figureMemberIds.length;
  const baseScale = scaleForStarCount(count);
  let scale = baseScale;
  const rotation = (hashUnit(seed, 11) - 0.5) * Math.PI * 0.5;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const stars = shape.stars.slice(0, count);
  if (count > 1) {
    let minDist = Infinity;
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        minDist = Math.min(minDist, Math.hypot(stars[i].x - stars[j].x, stars[i].y - stars[j].y));
      }
    }
    if (minDist > 0 && minDist * scale < FIGURE_STAR_MIN) {
      // Open the figure up until its tightest pair clears a label, but never
      // so far that one cluster swallows the sky.
      scale = Math.min(FIGURE_STAR_MIN / minDist, baseScale * FIGURE_MAX_UPSCALE);
    }
  }

  if (count > 1) {
    // FIGURE_STAR_MIN is a circle, but a name is a LABEL_WIDTH x LABEL_HEIGHT box: a pair 106px
    // apart along a tilted diagonal can still have overlapping names. Open the figure just far
    // enough that no two name boxes touch. This applies to every figure and is a single uniform
    // scale, so the asterism is never warped. It deliberately ignores FIGURE_MAX_UPSCALE: the
    // bump is measured at no more than ~4.1% and the templates are fixed, so it cannot run away.
    // Do not cap it, or a clash could come back.
    let need = 0;
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const dx = Math.abs((stars[i].x - stars[j].x) * cos - (stars[i].y - stars[j].y) * sin);
        const dy = Math.abs((stars[i].x - stars[j].x) * sin + (stars[i].y - stars[j].y) * cos);
        if (dx < 1e-9 && dy < 1e-9) continue;
        need = Math.max(
          need,
          Math.min(dx > 1e-9 ? LABEL_WIDTH / dx : Infinity, dy > 1e-9 ? LABEL_HEIGHT / dy : Infinity)
        );
      }
    }
    if (need * (1 + 1e-6) > scale) scale = need * (1 + 1e-6);
  }

  const figureLocal = stars.map((s) => ({
    x: (s.x * cos - s.y * sin) * scale,
    y: (s.x * sin + s.y * cos) * scale,
  }));
  const figureExtent = figureLocal.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.y)), scale * 0.3);

  const { placed: scatterLocal, outer } = scatterField(
    scatterIds,
    seed,
    figureExtent + SCATTER_CLEAR,
    SCATTER_FIELD_WIDTH,
    figureLocal
  );
  const outermost = scatterLocal.length > 0 ? outer : figureExtent;
  return { figureLocal, scatterLocal, foot: outermost + FOOT_MARGIN };
}

/** A school: members on rings, the overflow scattered outside them. */
export function ringGeometry(figureMemberIds: string[], scatterIds: string[], seed: string): LocalPart {
  const { positions, radius } = ringLayout(figureMemberIds.length, seed);
  const { placed: scatterLocal, outer } = scatterField(
    scatterIds,
    seed,
    radius + SCATTER_CLEAR,
    SCATTER_FIELD_WIDTH,
    positions
  );
  const outermost = scatterLocal.length > 0 ? outer : radius;
  return { figureLocal: positions, scatterLocal, foot: outermost + FOOT_MARGIN, ringRadius: radius };
}

/**
 * Build a cluster's local geometry, part by part.
 *
 * A cluster that is not split is one part built exactly as it always was (same seed, so the
 * same tilt and scatter). A petal company builds each part — the leadership core and every
 * function petal — the same way under its own seed, then `arrangeParts` seats the core at the
 * origin and the petals round it on disjoint footprints.
 */
export function buildClusterGeometry(
  fit: ClusterFit,
  /**
   * People seated in this cluster's field without being members of it: loners from the same
   * company family (see `familySatellites`). Placed after the members, so further out — in the
   * largest petal, for a company that is split.
   */
  satelliteIds: string[] = []
): ClusterGeometry {
  const { cluster, form, parts } = fit;
  const roomiest = parts.reduce(
    (best, p, i) =>
      p.role !== "core" && p.figureMemberIds.length + p.scatterMemberIds.length >
        best.size
        ? { i, size: p.figureMemberIds.length + p.scatterMemberIds.length }
        : best,
    { i: 0, size: -1 }
  ).i;

  const built = parts.map((part, i) => {
    const seed = form === "petal" ? `${cluster.id}#${part.key}` : cluster.id;
    const scatterIds = [...part.scatterMemberIds, ...(i === roomiest ? satelliteIds : [])];
    return form === "ring"
      ? ringGeometry(part.figureMemberIds, scatterIds, seed)
      : figureGeometry(part.shape, part.figureMemberIds, scatterIds, seed);
  });

  if (form !== "petal") {
    return {
      cluster,
      fit,
      parts: [{ part: parts[0], center: { x: 0, y: 0 }, ...built[0] }],
      foot: built[0].foot,
    };
  }

  const coreIndex = parts.findIndex((p) => p.role === "core");
  const arranged = arrangeParts(
    coreIndex >= 0 ? { key: parts[coreIndex].key, foot: built[coreIndex].foot } : null,
    parts
      .map((p, i) => ({ key: p.key, foot: built[i].foot, role: p.role }))
      .filter((p) => p.role === "petal")
      .map(({ key, foot }) => ({ key, foot })),
    PART_GAP,
    cluster.id
  );
  return {
    cluster,
    fit,
    foot: arranged.foot,
    parts: parts.map((part, i) => {
      const center = arranged.centers.get(part.key)!;
      return {
        part,
        center,
        foot: built[i].foot,
        figureLocal: built[i].figureLocal.map((p) => ({ x: center.x + p.x, y: center.y + p.y })),
        scatterLocal: built[i].scatterLocal.map((p) => ({ id: p.id, x: center.x + p.x, y: center.y + p.y })),
      };
    }),
  };
}
