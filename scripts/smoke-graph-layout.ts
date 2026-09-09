/**
 * Exercises the packed sky-atlas constellation layout: undistorted asterism
 * figures, guaranteed non-overlap of stars and figure lines, shell packing,
 * and the fit/edge agreement that used to be a hand-maintained invariant.
 * No DB, no network.
 * Run: npx tsx scripts/smoke-graph-layout.ts
 */

import {
  buildConstellationFit,
  constellationFitEdges,
} from "../src/lib/constellation-fit";
import {
  buildHybridGraphLayout,
  type GraphContactInput,
  type GraphNodeData,
} from "../src/lib/graph-layout";
import { buildPeerEdges } from "../src/lib/network-metrics";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

/** Any two star centers must be at least this far apart. */
const STAR_MIN_DIST = 18;
/** A star must keep this distance from any figure line it isn't part of. */
const LINE_MIN_DIST = 12;
/** No star may sit closer to the sun than this. */
const SUN_MIN_DIST = 150;
/** Always-on label box under each star (see graph-nodes.tsx). */
const LABEL_WIDTH = 104;
const LABEL_HEIGHT = 30;

function contact(
  id: string,
  opts: Partial<GraphContactInput> = {}
): GraphContactInput {
  return {
    id,
    fullName: `Person ${id}`,
    company: null,
    title: null,
    relationshipScore: 3,
    lastInteractionAt: "2026-08-20T00:00:00.000Z",
    nextFollowUpAt: null,
    tags: [],
    aiSummary: null,
    keyFacts: null,
    ...opts,
  };
}

/** A mid-size sky: two company families, schools, dormants, deep space. */
const fixture: GraphContactInput[] = [
  // Big cluster: figure cap + plenty of scatter.
  ...Array.from({ length: 22 }, (_, i) =>
    contact(`aws${i}`, {
      company: "Amazon Web Services",
      orbitScore: 1 + ((i * 7) % 5),
      ...(i % 6 === 5
        ? { lastInteractionAt: "2025-05-01T00:00:00.000Z", dormant: true }
        : {}),
    })
  ),
  contact("am1", { company: "Amazon", orbitScore: 4 }),
  contact("am2", { company: "Amazon", orbitScore: 3 }),
  contact("am3", { company: "Amazon", orbitScore: 2 }),
  ...Array.from({ length: 8 }, (_, i) =>
    contact(`g${i}`, { company: "Google", orbitScore: 1 + ((i * 3) % 5) })
  ),
  ...Array.from({ length: 5 }, (_, i) =>
    contact(`st${i}`, { company: "Stripe", orbitScore: 1 + (i % 5) })
  ),
  contact("ap1", { company: "Apple", orbitScore: 5 }),
  contact("ap2", { company: "Apple", orbitScore: 2 }),
  contact("s1", { school: "MIT", orbitScore: 4 }),
  contact("s2", { school: "MIT", orbitScore: 2 }),
  contact("s3", { school: "MIT", orbitScore: 1 }),
  // Singleton company → background rim, not a wedge.
  contact("solo", { company: "Tiny Startup", orbitScore: 3 }),
  // Deep space.
  ...Array.from({ length: 7 }, (_, i) =>
    contact(`d${i}`, { orbitScore: 1 + (i % 5) })
  ),
];

const fit = buildConstellationFit(fixture);
const layout = buildHybridGraphLayout(fixture, "Tester");
const contactNodes = layout.nodes.filter((n) => n.type === "contact");
const posById = new Map(contactNodes.map((n) => [n.id, n.position]));

// ---------------------------------------------------------------------------
console.log("\nFit assignment");

{
  const again = buildConstellationFit(fixture);
  check(
    "fit is deterministic",
    JSON.stringify([...fit.fits.entries()]) ===
      JSON.stringify([...again.fits.entries()])
  );

  check(
    "only company/school clusters with ≥2 members get figures",
    [...fit.fits.values()].every(
      ({ cluster }) => cluster.kind !== "other" && cluster.count >= 2
    ) && ![...fit.fits.values()].some((f) => f.cluster.name === "Tiny Startup")
  );

  // Figure members are the top of the placement order, aligned to shape stars.
  for (const f of fit.fits.values()) {
    check(
      `figure size matches shape (${f.cluster.name})`,
      f.figureMemberIds.length ===
        Math.min(f.shape.stars.length, f.cluster.count),
      `${f.figureMemberIds.length} vs ${f.shape.stars.length}`
    );
  }
}

// ---------------------------------------------------------------------------
console.log("\nLayout basics");

{
  check(
    "every contact gets a star",
    contactNodes.length === fixture.length,
    `${contactNodes.length}/${fixture.length}`
  );
  const layoutAgain = buildHybridGraphLayout(fixture, "Tester");
  check(
    "layout is deterministic",
    JSON.stringify(layout) === JSON.stringify(layoutAgain)
  );
  check(
    "every star keeps clear of the sun",
    contactNodes.every(
      (n) => Math.hypot(n.position.x, n.position.y) >= SUN_MIN_DIST
    )
  );
  const figureIds = new Set(
    [...fit.fits.values()].flatMap((f) => f.figureMemberIds)
  );
  check(
    "figureRole matches the fit's figure membership",
    contactNodes.every(
      (n) =>
        ((n.data as GraphNodeData).figureRole === "figure") ===
        figureIds.has(n.id)
    )
  );
}

// ---------------------------------------------------------------------------
console.log("\nShape fidelity (figures are undistorted asterisms)");

{
  for (const f of fit.fits.values()) {
    const pts = f.figureMemberIds.map((id) => posById.get(id)!);
    const stars = f.shape.stars.slice(0, f.figureMemberIds.length);
    if (pts.length < 2) continue;
    // A similarity transform preserves all pairwise distance ratios.
    let ratio: number | null = null;
    let faithful = true;
    for (let i = 0; i < pts.length && faithful; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dShape = Math.hypot(
          stars[i].x - stars[j].x,
          stars[i].y - stars[j].y
        );
        if (dShape < 1e-9) continue;
        const dLayout = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        const r = dLayout / dShape;
        if (ratio == null) ratio = r;
        else if (Math.abs(r - ratio) > ratio * 1e-6) {
          faithful = false;
          break;
        }
      }
    }
    check(`figure is a pure similarity transform (${f.cluster.name})`, faithful);
  }
}

// ---------------------------------------------------------------------------
console.log("\nNo overlaps");

{
  // Star–star: global pairwise minimum distance.
  let minPair = Infinity;
  let worst = "";
  for (let i = 0; i < contactNodes.length; i++) {
    for (let j = i + 1; j < contactNodes.length; j++) {
      const a = contactNodes[i];
      const b = contactNodes[j];
      const d = Math.hypot(
        a.position.x - b.position.x,
        a.position.y - b.position.y
      );
      if (d < minPair) {
        minPair = d;
        worst = `${a.id}↔${b.id}`;
      }
    }
  }
  check(
    `no two stars overlap (min pair distance ${minPair.toFixed(1)}px ≥ ${STAR_MIN_DIST})`,
    minPair >= STAR_MIN_DIST,
    worst
  );

  // Label–label: every star wears an always-visible name + role, so the
  // worst-case label boxes must stay clear of each other too.
  let labelClashes = 0;
  let worstLabel = "";
  for (let i = 0; i < contactNodes.length; i++) {
    for (let j = i + 1; j < contactNodes.length; j++) {
      const a = contactNodes[i].position;
      const b = contactNodes[j].position;
      if (
        Math.abs(a.x - b.x) < LABEL_WIDTH &&
        Math.abs(a.y - b.y) < LABEL_HEIGHT
      ) {
        labelClashes += 1;
        if (!worstLabel) {
          worstLabel = `${contactNodes[i].id}↔${contactNodes[j].id}`;
        }
      }
    }
  }
  check(
    "no two star labels can overlap (worst-case boxes)",
    labelClashes === 0,
    `${labelClashes} clashes, first ${worstLabel}`
  );

  // Star–line: every star keeps distance from every figure segment it does
  // not terminate.
  const segments = layout.edges.map((e) => ({
    a: posById.get(e.source)!,
    b: posById.get(e.target)!,
    ids: new Set([e.source, e.target]),
    label: `${e.source}→${e.target}`,
  }));
  let minSeg = Infinity;
  let worstSeg = "";
  for (const n of contactNodes) {
    for (const s of segments) {
      if (s.ids.has(n.id)) continue;
      const abx = s.b.x - s.a.x;
      const aby = s.b.y - s.a.y;
      const len2 = abx * abx + aby * aby;
      const t =
        len2 > 0
          ? Math.max(
              0,
              Math.min(
                1,
                ((n.position.x - s.a.x) * abx + (n.position.y - s.a.y) * aby) /
                  len2
              )
            )
          : 0;
      const d = Math.hypot(
        n.position.x - (s.a.x + abx * t),
        n.position.y - (s.a.y + aby * t)
      );
      if (d < minSeg) {
        minSeg = d;
        worstSeg = `${n.id} vs ${s.label}`;
      }
    }
  }
  check(
    `no star touches a foreign figure line (min ${minSeg.toFixed(1)}px ≥ ${LINE_MIN_DIST})`,
    minSeg >= LINE_MIN_DIST,
    worstSeg
  );

  // Line–line: no two figure segments properly intersect (shared endpoints ok).
  const cross = (ox: number, oy: number, ax: number, ay: number, bx: number, by: number) =>
    (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
  let crossings = 0;
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const s = segments[i];
      const t = segments[j];
      if ([...s.ids].some((id) => t.ids.has(id))) continue;
      const d1 = cross(s.a.x, s.a.y, s.b.x, s.b.y, t.a.x, t.a.y);
      const d2 = cross(s.a.x, s.a.y, s.b.x, s.b.y, t.b.x, t.b.y);
      const d3 = cross(t.a.x, t.a.y, t.b.x, t.b.y, s.a.x, s.a.y);
      const d4 = cross(t.a.x, t.a.y, t.b.x, t.b.y, s.b.x, s.b.y);
      if (d1 * d2 < 0 && d3 * d4 < 0) crossings += 1;
    }
  }
  check("no two figure lines cross", crossings === 0, `${crossings} crossings`);

  // Cluster–cluster: footprint separation via per-cluster bounding circles.
  const clusterPoints = new Map<string, Array<{ x: number; y: number }>>();
  for (const n of contactNodes) {
    const d = n.data as GraphNodeData;
    if (!d.clusterId || !fit.fits.has(d.clusterId)) continue;
    const list = clusterPoints.get(d.clusterId) ?? [];
    list.push(n.position);
    clusterPoints.set(d.clusterId, list);
  }
  const hulls = [...clusterPoints.entries()].map(([id, pts]) => {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const r = pts.reduce((m, p) => Math.max(m, Math.hypot(p.x - cx, p.y - cy)), 0);
    return { id, cx, cy, r };
  });
  let clustersApart = true;
  for (let i = 0; i < hulls.length; i++) {
    for (let j = i + 1; j < hulls.length; j++) {
      const a = hulls[i];
      const b = hulls[j];
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.r + b.r + STAR_MIN_DIST) {
        clustersApart = false;
      }
    }
  }
  check("cluster star fields are pairwise disjoint", clustersApart);
}

// ---------------------------------------------------------------------------
console.log("\nEdges match the fit (the old hand-maintained invariant)");

{
  const pair = (a: string, b: string) => (a < b ? `${a}::${b}` : `${b}::${a}`);
  const fitPairs = new Set(
    constellationFitEdges(fit).map((e) => pair(e.source, e.target))
  );
  const peerPairs = new Set(
    buildPeerEdges(fixture, { constellationOnly: true }).map((e) =>
      pair(e.source, e.target)
    )
  );
  const layoutPairs = new Set(layout.edges.map((e) => pair(e.source, e.target)));

  const sameSets = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((k) => b.has(k));

  check(
    "buildPeerEdges lines equal the fit's figure lines",
    sameSets(fitPairs, peerPairs)
  );
  check("layout edges equal the fit's figure lines", sameSets(fitPairs, layoutPairs));

  const figureIds = new Set(
    [...fit.fits.values()].flatMap((f) => f.figureMemberIds)
  );
  check(
    "every figure line connects two figure stars",
    [...fitPairs].every((k) => {
      const [a, b] = k.split("::");
      return figureIds.has(a) && figureIds.has(b);
    })
  );
}

// ---------------------------------------------------------------------------
console.log("\nLarge sky (real-network scale: many clusters, deep belt)");

{
  // ~75 clusters of mixed sizes plus a large deep-space population —
  // roughly the shape of a real, imported network.
  const large: GraphContactInput[] = [];
  for (let c = 0; c < 75; c++) {
    const size = 2 + ((c * 7) % 25);
    for (let m = 0; m < size; m++) {
      large.push(
        contact(`c${c}m${m}`, {
          company: `Company ${c}`,
          orbitScore: 1 + ((c + m) % 5),
        })
      );
    }
  }
  for (let d = 0; d < 220; d++) {
    large.push(contact(`ds${d}`, { orbitScore: 1 + (d % 5) }));
  }

  const bigLayout = buildHybridGraphLayout(large, "Tester");
  const bigNodes = bigLayout.nodes.filter((n) => n.type === "contact");
  check(
    "every contact gets a star",
    bigNodes.length === large.length,
    `${bigNodes.length}/${large.length}`
  );
  check(
    "layout is deterministic at scale",
    JSON.stringify(bigLayout) ===
      JSON.stringify(buildHybridGraphLayout(large, "Tester"))
  );

  // Star–star and worst-case label boxes, over the whole sky.
  let minPair = Infinity;
  let labelClashes = 0;
  for (let i = 0; i < bigNodes.length; i++) {
    for (let j = i + 1; j < bigNodes.length; j++) {
      const a = bigNodes[i].position;
      const b = bigNodes[j].position;
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      minPair = Math.min(minPair, Math.hypot(dx, dy));
      if (dx < LABEL_WIDTH && dy < LABEL_HEIGHT) labelClashes += 1;
    }
  }
  check(
    `no two stars overlap at scale (min ${minPair.toFixed(1)}px ≥ ${STAR_MIN_DIST})`,
    minPair >= STAR_MIN_DIST
  );
  check("no label boxes overlap at scale", labelClashes === 0, String(labelClashes));
  check(
    "every star keeps clear of the sun at scale",
    bigNodes.every((n) => Math.hypot(n.position.x, n.position.y) >= SUN_MIN_DIST)
  );

  // Cluster hulls stay disjoint even with jitter + spiral drift applied.
  const bigFit = buildConstellationFit(large);
  const byCluster = new Map<string, Array<{ x: number; y: number }>>();
  for (const n of bigNodes) {
    const d = n.data as GraphNodeData;
    if (!d.clusterId || !bigFit.fits.has(d.clusterId)) continue;
    const list = byCluster.get(d.clusterId) ?? [];
    list.push(n.position);
    byCluster.set(d.clusterId, list);
  }
  const hulls = [...byCluster.values()].map((pts) => {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const r = pts.reduce(
      (m, p) => Math.max(m, Math.hypot(p.x - cx, p.y - cy)),
      0
    );
    return { cx, cy, r };
  });
  let apart = true;
  for (let i = 0; i < hulls.length; i++) {
    for (let j = i + 1; j < hulls.length; j++) {
      if (
        Math.hypot(hulls[i].cx - hulls[j].cx, hulls[i].cy - hulls[j].cy) <
        hulls[i].r + hulls[j].r + STAR_MIN_DIST
      ) {
        apart = false;
      }
    }
  }
  check("cluster star fields stay pairwise disjoint at scale", apart);

  // The deep-space rim is a belt, not a circle: its members span real radial
  // depth instead of hugging one radius.
  const beltRadii = bigNodes
    .filter((n) => n.id.startsWith("ds"))
    .map((n) => Math.hypot(n.position.x, n.position.y));
  const beltDepth = Math.max(...beltRadii) - Math.min(...beltRadii);
  check(
    `deep-space rim has asteroid-belt depth (${beltDepth.toFixed(0)}px ≥ 120)`,
    beltDepth >= 120
  );

  // Shells wind outward: clusters on one shell should not all sit at the
  // same radius (spiral drift + jitter give each shell real radial texture).
  const centersByShellBand = hulls
    .map((h) => Math.hypot(h.cx, h.cy))
    .sort((a, b) => a - b);
  const uniqueish = new Set(centersByShellBand.map((r) => Math.round(r / 40)));
  check(
    "cluster radii vary (galaxy texture, not concentric circles)",
    uniqueish.size > Math.min(12, hulls.length / 3),
    `${uniqueish.size} distinct radius bands`
  );
}

console.log("\nAll graph-layout smoke checks passed.\n");
process.exit(0);
