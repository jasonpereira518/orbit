/**
 * The geometry of a cluster's parts, on plain numbers.
 *
 * Two shapes need real geometry beyond "a figure plus scatter":
 *   - a school is a RING: members on a circle (and inner circles when there are many), so the
 *     cluster reads as a school rather than a constellation;
 *   - a big company is a CORE with PETALS: the parts' footprint disks sit round the core, each
 *     part built by the ordinary figure-plus-scatter code, and this module says where.
 *
 * Every spacing here is chosen so name labels cannot overlap: two stars need a centre distance
 * of at least the diagonal of a label-clearance box (112 × 44 → ~120), not merely 112 sideways.
 */

import { hashUnit } from "@/lib/hash";

export const RING_SPACING = 124;
export const RING_MIN_RADIUS = 124;
export const RING_MAX_RADIUS = 420;

/** Stars that fit on a ring of `radius` with centres at least `spacing` apart. */
export function ringCapacity(radius: number, spacing = RING_SPACING): number {
  const half = Math.min(1, spacing / (2 * radius));
  return Math.floor(Math.PI / Math.asin(half) + 1e-9);
}

function ringRadii(outer: number): number[] {
  const radii: number[] = [];
  for (let r = outer; r >= RING_MIN_RADIUS - 1e-9; r -= RING_SPACING) radii.push(r);
  return radii;
}

/** The most stars the rings ever hold: a full-size outer ring and every ring inside it. */
export const RING_CAPACITY = ringRadii(RING_MAX_RADIUS).reduce((sum, r) => sum + ringCapacity(r), 0);

export type RingLayout = {
  positions: Array<{ x: number; y: number }>;
  /** The outermost ring's radius. */
  radius: number;
};

/**
 * `count` stars on rings. The outer ring is just big enough for them all (or the largest
 * allowed); what does not fit goes on rings further in. Places at most `RING_CAPACITY` — the
 * caller scatters the rest. The seed only rotates the whole figure.
 */
export function ringLayout(count: number, seed: string): RingLayout {
  const n = Math.min(count, RING_CAPACITY);
  const outer = Math.min(
    RING_MAX_RADIUS,
    Math.max(RING_MIN_RADIUS, RING_SPACING / (2 * Math.sin(Math.PI / Math.max(3, n))))
  );
  const start = hashUnit(seed, 41) * Math.PI * 2;
  const positions: Array<{ x: number; y: number }> = [];
  let left = n;
  ringRadii(outer).forEach((radius, ring) => {
    if (left <= 0) return;
    const k = Math.min(left, ringCapacity(radius));
    // Alternate rings are offset by half a step, so stars on neighbouring rings do not line up.
    const offset = start + (ring % 2 ? Math.PI / k : 0);
    for (let i = 0; i < k; i++) {
      const angle = offset + (i / k) * Math.PI * 2;
      positions.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    }
    left -= k;
  });
  return { positions, radius: outer };
}

export type PartDisk = { key: string; foot: number };
export type PartArrangement = {
  centers: Map<string, { x: number; y: number }>;
  /** Radius of the disk, centred on the cluster origin, that holds every part. */
  foot: number;
};

const codepoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Place the core at the origin and the petals on a ring round it, no two footprint disks
 * closer than `gap`.
 *
 * Big and small petals alternate round the ring (two giants side by side would set the radius
 * for everyone). The ring's radius is the smallest whose adjacent-pair arcs fit in a circle,
 * then a verification pass grows it until EVERY pair — not just neighbours — clears, because a
 * big disk can reach past its neighbour to the next one.
 */
export function arrangeParts(
  core: PartDisk | null,
  petals: PartDisk[],
  gap: number,
  seed: string
): PartArrangement {
  const centers = new Map<string, { x: number; y: number }>();
  const coreFoot = core?.foot ?? 0;
  if (core) centers.set(core.key, { x: 0, y: 0 });
  if (petals.length === 0) return { centers, foot: coreFoot };
  const start = hashUnit(seed, 43) * Math.PI * 2;

  const sorted = [...petals].sort((a, b) => b.foot - a.foot || codepoint(a.key, b.key));
  const order: PartDisk[] = [];
  for (let lo = 0, hi = sorted.length - 1; lo <= hi; lo++, hi--) {
    order.push(sorted[lo]);
    if (lo !== hi) order.push(sorted[hi]);
  }
  const n = order.length;
  const f = order.map((p) => p.foot);

  if (n === 1) {
    const d = core ? coreFoot + f[0] + gap : 0;
    centers.set(order[0].key, { x: Math.cos(start) * d, y: Math.sin(start) * d });
    return { centers, foot: Math.max(coreFoot, d + f[0]) };
  }

  const need = (i: number) => f[i] + f[(i + 1) % n] + gap;
  const arcs = (radius: number) => {
    let total = 0;
    for (let i = 0; i < n; i++) total += 2 * Math.asin(Math.min(1, need(i) / (2 * radius)));
    return total;
  };
  let R = Math.max(
    ...Array.from({ length: n }, (_, i) => need(i) / 2),
    core ? coreFoot + Math.max(...f) + gap : 0
  );
  if (arcs(R) > Math.PI * 2) {
    let lo = R;
    let hi = R * 2;
    while (arcs(hi) > Math.PI * 2) hi *= 2;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (arcs(mid) > Math.PI * 2) lo = mid;
      else hi = mid;
    }
    R = hi;
  }

  const place = (radius: number) => {
    const slack = Math.max(0, Math.PI * 2 - arcs(radius)) / n;
    const out: Array<{ x: number; y: number }> = [];
    let theta = start;
    for (let i = 0; i < n; i++) {
      out.push({ x: Math.cos(theta) * radius, y: Math.sin(theta) * radius });
      theta += 2 * Math.asin(Math.min(1, need(i) / (2 * radius))) + slack;
    }
    return out;
  };
  const clear = (pts: Array<{ x: number; y: number }>) => {
    for (let i = 0; i < n; i++) {
      if (core && Math.hypot(pts[i].x, pts[i].y) < coreFoot + f[i] + gap - 1e-6) return false;
      for (let j = i + 1; j < n; j++) {
        if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < f[i] + f[j] + gap - 1e-6) return false;
      }
    }
    return true;
  };
  let pts = place(R);
  for (let tries = 0; tries < 200 && !clear(pts); tries++) {
    R *= 1.04;
    pts = place(R);
  }
  order.forEach((p, i) => centers.set(p.key, pts[i]));
  return { centers, foot: Math.max(coreFoot, R + Math.max(...f)) };
}
