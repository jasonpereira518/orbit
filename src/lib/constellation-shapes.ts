/**
 * Real-sky constellation templates used to place & link cluster stars.
 * Coordinates are unit-ish; layout scales/rotates them per cluster.
 */

export type ConstellationShape = {
  id: string;
  name: string;
  /** Relative star positions (any scale; normalized at use time) */
  stars: Array<{ x: number; y: number }>;
  /** Index pairs into `stars` — the white constellation lines */
  edges: Array<[number, number]>;
};

/** Exact classic figures by star count (and a few alternates). */
const SHAPES: ConstellationShape[] = [
  {
    id: "line-2",
    name: "Pair",
    stars: [
      { x: -1, y: 0 },
      { x: 1, y: 0 },
    ],
    edges: [[0, 1]],
  },
  {
    id: "orion-belt",
    name: "Orion's Belt",
    stars: [
      { x: -1, y: 0.15 },
      { x: 0, y: 0 },
      { x: 1, y: -0.12 },
    ],
    edges: [
      [0, 1],
      [1, 2],
    ],
  },
  {
    id: "southern-cross",
    name: "Crux",
    stars: [
      { x: 0, y: -1.1 },
      { x: 0, y: 1 },
      { x: -0.85, y: 0.15 },
      { x: 0.9, y: 0.05 },
    ],
    edges: [
      [0, 1],
      [2, 3],
    ],
  },
  // Cassiopeia — classic W
  {
    id: "cassiopeia",
    name: "Cassiopeia",
    stars: [
      { x: -1.2, y: 0.35 },
      { x: -0.55, y: -0.55 },
      { x: 0, y: 0.45 },
      { x: 0.55, y: -0.5 },
      { x: 1.2, y: 0.4 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ],
  },
  // Cepheus — house / pointed pentagon
  {
    id: "cepheus",
    name: "Cepheus",
    stars: [
      { x: 0, y: -1.15 },
      { x: -0.85, y: -0.15 },
      { x: -0.7, y: 1 },
      { x: 0.7, y: 1 },
      { x: 0.85, y: -0.15 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 0],
    ],
  },
  // Lyra — small triangle + diamond (Vega at tip)
  {
    id: "lyra",
    name: "Lyra",
    stars: [
      { x: 0, y: -1.2 }, // Vega
      { x: -0.35, y: -0.35 },
      { x: 0.35, y: -0.35 },
      { x: -0.55, y: 0.7 },
      { x: 0.55, y: 0.7 },
    ],
    edges: [
      [0, 1],
      [0, 2],
      [1, 2],
      [1, 3],
      [2, 4],
      [3, 4],
    ],
  },
  {
    id: "corona",
    name: "Corona Borealis",
    stars: [
      { x: -1, y: 0.2 },
      { x: -0.55, y: -0.55 },
      { x: 0, y: -0.85 },
      { x: 0.55, y: -0.55 },
      { x: 1, y: 0.15 },
      { x: 0.35, y: 0.75 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 0],
    ],
  },
  // Ursa Minor / Little Dipper
  {
    id: "ursa-minor",
    name: "Ursa Minor",
    stars: [
      { x: 1.3, y: -0.15 }, // Polaris handle tip
      { x: 0.75, y: 0.05 },
      { x: 0.25, y: 0.2 },
      { x: -0.15, y: -0.35 },
      { x: -0.85, y: -0.55 },
      { x: -1.1, y: 0.15 },
      { x: -0.45, y: 0.55 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 3],
    ],
  },
  // Bootes — kite + Arcturus
  {
    id: "bootes",
    name: "Boötes",
    stars: [
      { x: 0, y: 1.25 }, // Arcturus
      { x: -0.15, y: 0.45 },
      { x: -0.7, y: -0.1 },
      { x: -0.35, y: -0.85 },
      { x: 0.4, y: -0.9 },
      { x: 0.75, y: -0.15 },
      { x: 0.25, y: 0.35 },
      { x: -0.05, y: -0.25 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 1],
      [2, 7],
      [7, 5],
    ],
  },
  // Big Dipper (Ursa Major asterism) — 7 is already Ursa Minor; this is 9-star dipper+
  {
    id: "ursa-major-core",
    name: "Ursa Major",
    stars: [
      { x: -1.4, y: 0.35 },
      { x: -0.85, y: 0.55 },
      { x: -0.25, y: 0.5 },
      { x: 0.25, y: 0.35 },
      { x: 0.35, y: -0.25 },
      { x: -0.15, y: -0.45 },
      { x: -0.75, y: -0.2 },
      { x: 0.85, y: 0.15 },
      { x: 1.35, y: -0.35 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 2],
      [3, 7],
      [7, 8],
    ],
  },
  // Hercules — sprawling H / stick figure (~12)
  {
    id: "hercules",
    name: "Hercules",
    stars: [
      { x: -0.9, y: -1.1 },
      { x: -0.35, y: -0.55 },
      { x: 0.35, y: -0.55 },
      { x: 0.9, y: -1.05 },
      { x: -0.45, y: 0.1 },
      { x: 0.45, y: 0.1 },
      { x: -0.85, y: 0.7 },
      { x: 0.85, y: 0.7 },
      { x: -0.25, y: 1.15 },
      { x: 0.3, y: 1.2 },
      { x: 0, y: -0.15 },
      { x: 0, y: 0.55 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [1, 4],
      [2, 5],
      [4, 5],
      [4, 6],
      [5, 7],
      [6, 8],
      [7, 9],
      [4, 10],
      [10, 11],
      [11, 5],
    ],
  },
  // Draco — long winding serpent (~15)
  {
    id: "draco",
    name: "Draco",
    stars: [
      { x: 1.4, y: 0.9 },
      { x: 1.05, y: 0.55 },
      { x: 0.7, y: 0.85 },
      { x: 0.35, y: 0.45 },
      { x: 0.55, y: 0.05 },
      { x: 0.15, y: -0.25 },
      { x: -0.25, y: -0.05 },
      { x: -0.55, y: -0.45 },
      { x: -0.95, y: -0.25 },
      { x: -1.15, y: 0.2 },
      { x: -0.85, y: 0.55 },
      { x: -0.45, y: 0.75 },
      { x: -0.1, y: 1.05 },
      { x: 0.35, y: 1.2 },
      { x: 0.75, y: 1.0 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 8],
      [8, 9],
      [9, 10],
      [10, 11],
      [11, 12],
      [12, 13],
      [13, 14],
    ],
  },
  // Full Ursa Major-ish sprawl (~17)
  {
    id: "ursa-major-full",
    name: "Ursa Major",
    stars: [
      { x: -1.5, y: 0.4 },
      { x: -1.0, y: 0.65 },
      { x: -0.45, y: 0.6 },
      { x: 0.05, y: 0.4 },
      { x: 0.2, y: -0.2 },
      { x: -0.3, y: -0.45 },
      { x: -0.9, y: -0.15 },
      { x: 0.65, y: 0.2 },
      { x: 1.15, y: -0.25 },
      { x: 1.55, y: -0.55 },
      { x: -1.35, y: -0.55 },
      { x: -0.7, y: -0.85 },
      { x: 0.1, y: -0.95 },
      { x: 0.7, y: -0.7 },
      { x: -0.2, y: 1.0 },
      { x: 0.5, y: 0.95 },
      { x: 1.0, y: 0.55 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 2],
      [3, 7],
      [7, 8],
      [8, 9],
      [0, 10],
      [10, 11],
      [11, 12],
      [12, 13],
      [1, 14],
      [14, 15],
      [15, 16],
      [16, 7],
    ],
  },
];

function hashUnit(id: string, salt = 0) {
  let h = salt * 2654435761;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return (h % 10000) / 10000;
}

function normalizeStars(stars: Array<{ x: number; y: number }>) {
  const cx = stars.reduce((s, p) => s + p.x, 0) / stars.length;
  const cy = stars.reduce((s, p) => s + p.y, 0) / stars.length;
  let maxR = 0.001;
  const centered = stars.map((p) => {
    const x = p.x - cx;
    const y = p.y - cy;
    maxR = Math.max(maxR, Math.hypot(x, y));
    return { x, y };
  });
  return centered.map((p) => ({ x: p.x / maxR, y: p.y / maxR }));
}

/** Extend a base shape with extra stars in the same winding style. */
function extendShape(
  base: ConstellationShape,
  targetCount: number,
  seed: string
): ConstellationShape {
  const stars = [...base.stars];
  const edges = base.edges.map(([a, b]) => [a, b] as [number, number]);

  // Prefer extending from high-degree or tip endpoints
  const degree = new Array(stars.length).fill(0);
  for (const [a, b] of edges) {
    degree[a] += 1;
    degree[b] += 1;
  }

  while (stars.length < targetCount) {
    const tips = degree
      .map((d, i) => ({ d, i }))
      .filter((t) => t.d === 1)
      .map((t) => t.i);
    const from =
      tips.length > 0
        ? tips[Math.floor(hashUnit(seed, stars.length) * tips.length)]
        : stars.length - 1;

    const neighborEdge = edges.find(([a, b]) => a === from || b === from);
    const prev =
      neighborEdge == null
        ? from
        : neighborEdge[0] === from
          ? neighborEdge[1]
          : neighborEdge[0];

    const fx = stars[from].x;
    const fy = stars[from].y;
    const px = stars[prev]?.x ?? fx - 0.4;
    const py = stars[prev]?.y ?? fy;
    const dx = fx - px;
    const dy = fy - py;
    const len = Math.hypot(dx, dy) || 0.45;
    const turn =
      (stars.length % 2 === 0 ? 0.55 : -0.5) +
      (hashUnit(seed, stars.length + 7) - 0.5) * 0.45;
    const ang = Math.atan2(dy, dx) + turn;
    const step = len * (0.9 + hashUnit(seed, stars.length + 3) * 0.35);

    const next = {
      x: fx + Math.cos(ang) * step,
      y: fy + Math.sin(ang) * step,
    };
    const idx = stars.length;
    stars.push(next);
    edges.push([from, idx]);
    degree.push(1);
    degree[from] += 1;
  }

  return {
    id: `${base.id}-ext-${targetCount}`,
    name: base.name,
    stars,
    edges,
  };
}

function shapesForCount(n: number): ConstellationShape[] {
  return SHAPES.filter((s) => s.stars.length === n);
}

/**
 * Pick a real constellation figure for `starCount`.
 * Exact match when possible; otherwise nearest smaller, then extend
 * in the same style when larger than every template.
 */
export function resolveConstellationShape(
  starCount: number,
  seed: string
): ConstellationShape {
  if (starCount <= 1) {
    return {
      id: "single",
      name: "Star",
      stars: [{ x: 0, y: 0 }],
      edges: [],
    };
  }

  const exact = shapesForCount(starCount);
  if (exact.length > 0) {
    const pick = exact[Math.floor(hashUnit(seed, 1) * exact.length) % exact.length];
    return {
      ...pick,
      stars: normalizeStars(pick.stars),
    };
  }

  // Prefer a nearby smaller classic figure, then extend
  const smaller = SHAPES.filter((s) => s.stars.length < starCount).sort(
    (a, b) => b.stars.length - a.stars.length
  );
  const larger = SHAPES.filter((s) => s.stars.length > starCount).sort(
    (a, b) => a.stars.length - b.stars.length
  );

  if (smaller.length > 0 && starCount - smaller[0].stars.length <= 4) {
    const base =
      smaller[Math.floor(hashUnit(seed, 2) * Math.min(3, smaller.length))];
    const extended = extendShape(base, starCount, seed);
    return { ...extended, stars: normalizeStars(extended.stars) };
  }

  if (larger.length > 0 && larger[0].stars.length - starCount <= 2) {
    // Trim a slightly larger figure: keep first N stars + edges that stay in range
    const base = larger[0];
    const stars = base.stars.slice(0, starCount);
    const edges = base.edges.filter(([a, b]) => a < starCount && b < starCount);
    // Ensure connectivity — link orphans into the path
    const connected = new Set<number>([0]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [a, b] of edges) {
        if (connected.has(a) && !connected.has(b)) {
          connected.add(b);
          grew = true;
        } else if (connected.has(b) && !connected.has(a)) {
          connected.add(a);
          grew = true;
        }
      }
    }
    for (let i = 0; i < starCount; i++) {
      if (!connected.has(i)) {
        edges.push([i - 1 >= 0 ? i - 1 : 0, i]);
        connected.add(i);
      }
    }
    return {
      id: `${base.id}-trim-${starCount}`,
      name: base.name,
      stars: normalizeStars(stars),
      edges,
    };
  }

  // Larger than every template — extend the biggest winding figure (Draco / Ursa)
  const biggest = [...SHAPES].sort(
    (a, b) => b.stars.length - a.stars.length
  )[0];
  const pickPool = SHAPES.filter((s) => s.stars.length >= 12);
  const base =
    pickPool[Math.floor(hashUnit(seed, 4) * pickPool.length)] || biggest;
  const extended = extendShape(base, starCount, seed);
  return { ...extended, stars: normalizeStars(extended.stars) };
}

export function scaleForStarCount(n: number) {
  // Keep figures roomy; larger constellations get a bigger canvas
  return 110 + Math.min(n, 20) * 14;
}
