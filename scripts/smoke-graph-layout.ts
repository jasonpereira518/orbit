/**
 * Exercises the galaxy constellation layout: undistorted asterism
 * figures, guaranteed non-overlap of stars and figure lines, disk placement,
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
  type NebulaData,
  type GraphNodeData,
  type ClusterLabelData,
} from "../src/lib/graph-layout";
import { figureStarCount } from "../src/lib/constellation-shapes";
import { CORE_TINT } from "../src/lib/constellation-parts";
import { RING_CAPACITY, RING_MIN_RADIUS } from "../src/lib/graph/cluster-anatomy";
import { buildClusterAffinity } from "../src/lib/constellation-affinity";
import { buildSyntheticGraphPayload } from "../src/lib/graph/synthetic-network";
import { buildPeerEdges } from "../src/lib/network-metrics";
import { clusterNameScale, petalNameFontPx } from "../src/components/graph/graph-nodes";
import { petalNameBoxes, starLabelBox, starLabelWinners, type LabelBox } from "../src/lib/graph/star-style";

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
/** A petal name is one text line this tall (the layout's PETAL_LABEL_HEIGHT). */
const PETAL_LABEL_HEIGHT = 16;

/**
 * Every petal name that lands on one of its own cluster's star names. A star's name and subtitle
 * hang under it (x ± 52, y + 8 … y + 34); a petal name is x ± 50 wide and PETAL_LABEL_HEIGHT tall
 * from its anchor, which the label node turns into an absolute position.
 */
function petalNameOverlaps(l: ReturnType<typeof buildHybridGraphLayout>) {
  const starsOf = new Map<string, Array<{ x: number; y: number }>>();
  for (const n of l.nodes) {
    if (n.type !== "contact") continue;
    const id = (n.data as GraphNodeData).clusterId;
    if (!id) continue;
    (starsOf.get(id) ?? starsOf.set(id, []).get(id)!).push(n.position);
  }
  let labels = 0;
  let overlaps = 0;
  for (const n of l.nodes) {
    if (n.type !== "clusterLabel") continue;
    const d = n.data as ClusterLabelData;
    for (const pl of d.petalLabels ?? []) {
      labels++;
      const ax = n.position.x - d.anchor!.x + pl.anchor.x;
      const ay = n.position.y - d.anchor!.y + pl.anchor.y;
      const hit = (starsOf.get(d.clusterId!) ?? []).some(
        (p) => ax - 50 < p.x + 52 && ax + 50 > p.x - 52 && ay < p.y + 34 && ay + PETAL_LABEL_HEIGHT > p.y + 8
      );
      if (hit) overlaps++;
    }
  }
  return { labels, overlaps };
}

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
  // A company big enough to split into a leadership core and function petals.
  ...["VP Engineering", "CTO", "Co-founder"].map((title, i) =>
    contact(`nw-l${i}`, { company: "Northwind", title, orbitScore: 5 - i })
  ),
  ...Array.from({ length: 11 }, (_, i) =>
    contact(`nw-e${i}`, {
      company: "Northwind",
      title: "Software Engineer",
      school: i % 2 ? "MIT" : i % 3 ? "Waterloo" : null,
      orbitScore: 1 + ((i * 3) % 5),
    })
  ),
  ...Array.from({ length: 8 }, (_, i) =>
    contact(`nw-d${i}`, { company: "Northwind", title: "Product Designer", orbitScore: 1 + ((i * 2) % 5) })
  ),
  ...Array.from({ length: 5 }, (_, i) =>
    contact(`nw-s${i}`, { company: "Northwind", title: "Account Executive", orbitScore: 1 + (i % 5) })
  ),
  // A school with enough alumni to be a ring, and one too big for its rings.
  ...Array.from({ length: 14 }, (_, i) =>
    contact(`ch${i}`, { school: "Chapel Hill", orbitScore: 1 + (i % 5) })
  ),
  ...Array.from({ length: 52 }, (_, i) =>
    contact(`su${i}`, { school: "State U", orbitScore: 1 + ((i * 2) % 5) })
  ),
  // Singleton company → halo, not a cluster.
  contact("solo", { company: "Tiny Startup", orbitScore: 3 }),
  // One-off companies, same function → a cross-company role constellation.
  contact("r1", { company: "Acme Robotics", title: "Backend Engineer", orbitScore: 3 }),
  contact("r2", { company: "Nimbus Labs", title: "Software Engineer", orbitScore: 4 }),
  // Two product managers with no company at all → a role cluster with nothing to count.
  contact("pm1", { title: "Product Manager", orbitScore: 3 }),
  contact("pm2", { title: "Product Manager", orbitScore: 2 }),
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
    "only named clusters with ≥2 members get figures",
    [...fit.fits.values()].every(
      ({ cluster }) => cluster.kind !== "other" && cluster.count >= 2
    ) && ![...fit.fits.values()].some((f) => f.cluster.name === "Tiny Startup")
  );
  check(
    "one-off engineers trace a role constellation",
    [...fit.fits.values()].some(
      (f) => f.cluster.kind === "role" && f.cluster.name === "Engineers" && f.cluster.count === 2
    )
  );
  check(
    "role figure lines are tagged as role edges",
    layout.edges.some((e) => e.data?.reason === "role")
  );

  // Figure members are the top of the placement order, aligned to shape stars.
  for (const f of fit.fits.values()) {
    for (const p of f.parts) {
      if (f.form === "ring") {
        check(`ring keeps every member it can (${f.cluster.name})`, p.figureMemberIds.length === Math.min(f.cluster.count, RING_CAPACITY));
        continue;
      }
      check(
        `figure size matches shape (${f.cluster.name}/${p.key})`,
        p.figureMemberIds.length ===
          Math.min(p.shape.stars.length, figureStarCount(p.figureMemberIds.length + p.scatterMemberIds.length)),
        `${p.figureMemberIds.length} vs ${p.shape.stars.length}`
      );
    }
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
  for (const f of fit.fits.values()) for (const part of f.parts) {
    if (f.form === "ring") continue;
    const pts = part.figureMemberIds.map((id) => posById.get(id)!);
    const stars = part.shape.stars.slice(0, part.figureMemberIds.length);
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
    check(`figure is a pure similarity transform (${f.cluster.name}/${part.key})`, faithful);
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

  // Line–line: no two figure segments properly intersect (shared endpoints ok). Segments that share
  // a star are skipped, so a template that crosses itself (the four-star Crux) is allowed: the
  // guarantee is no crossings between different figures.
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

  // Cluster–cluster, exactly: placeClusterDisks keeps every pair of footprint disks CLUSTER_GAP
  // apart and every star sits FOOT_MARGIN inside its disk, so stars of different clusters are at
  // least CLUSTER_GAP + 2·FOOT_MARGIN apart. Family satellites are seated in a foreign field on
  // purpose, so only stars in some fit's figure/scatter lists count.
  const CLUSTER_APART = LABEL_WIDTH + 2 * 34;
  const owned: Array<{ id: string; cluster: string; x: number; y: number }> = [];
  for (const f of fit.fits.values()) {
    for (const id of [...f.figureMemberIds, ...f.scatterMemberIds]) {
      const pos = posById.get(id)!;
      owned.push({ id, cluster: f.cluster.id, x: pos.x, y: pos.y });
    }
  }
  owned.sort((a, b) => a.x - b.x);
  let nearest = Infinity;
  let nearestPair = "";
  for (let i = 0; i < owned.length; i++) {
    for (let j = i + 1; j < owned.length && owned[j].x - owned[i].x < CLUSTER_APART; j++) {
      if (owned[i].cluster === owned[j].cluster) continue;
      const d = Math.hypot(owned[i].x - owned[j].x, owned[i].y - owned[j].y);
      if (d < nearest) {
        nearest = d;
        nearestPair = `${owned[i].id}↔${owned[j].id}`;
      }
    }
  }
  check(
    `stars of different clusters keep ${CLUSTER_APART}px apart (nearest ${nearest === Infinity ? "n/a" : nearest.toFixed(0) + "px"})`,
    nearest >= CLUSTER_APART - 1e-6,
    nearestPair
  );
}

// ---------------------------------------------------------------------------
console.log("\nCluster anatomy");

{
  const label = (name: string) =>
    layout.nodes.find((n) => n.type === "clusterLabel" && (n.data as { label?: string }).label === name)!
      .data as ClusterLabelData;
  const nw = [...fit.fits.values()].find((f) => f.cluster.name === "Northwind")!;
  check("Northwind is a petal cluster with a core and three petals", nw.form === "petal" && nw.parts.map((p) => p.key).join() === "core,petal:engineering,petal:design,petal:sales");
  check("its label node says so", label("Northwind").form === "petal");
  const petalLabels = label("Northwind").petalLabels ?? [];
  check("…with a label for the core and each petal", petalLabels.map((l) => l.label).join() === "Leadership,Engineering,Design,Sales & BD");
  check("…each fitting inside the node's box", petalLabels.every((l) => {
    const box = label("Northwind").box!;
    return l.anchor.x >= 0 && l.anchor.x <= box.width && l.anchor.y >= 0 && l.anchor.y + PETAL_LABEL_HEIGHT <= box.height;
  }));
  check("a plain figure has no petal labels", label("Google").petalLabels === undefined && label("Google").form === "figure");

  // Parts sit on disjoint footprints: each part's stars stay apart from the other parts'.
  const partStars = nw.parts.map((p) => [...p.figureMemberIds, ...p.scatterMemberIds].map((id) => posById.get(id)!));
  let apart = Infinity;
  for (let a = 0; a < partStars.length; a++)
    for (let b = a + 1; b < partStars.length; b++)
      for (const p of partStars[a]) for (const q of partStars[b]) apart = Math.min(apart, Math.hypot(p.x - q.x, p.y - q.y));
  check(`stars of different parts keep clear (${apart.toFixed(0)}px ≥ 120)`, apart >= 120);

  const star = (id: string) => contactNodes.find((n) => n.id === id)!.data as GraphNodeData;
  check("stars know their part", star("nw-l0").partKey === "core" && star("nw-l0").partRole === "core" && star("nw-e0").partKey === "petal:engineering");
  check("…and whether they lead", star("nw-l0").leader === true && star("nw-e0").leader === false);
  check("a star in an ordinary cluster is 'main' and carries no leader flag", star("aws0").partRole === "main" && star("aws0").leader === undefined);

  const ch = [...fit.fits.values()].find((f) => f.cluster.name === "Chapel Hill")!;
  check("Chapel Hill is a ring", ch.form === "ring" && label("Chapel Hill").form === "ring");
  check("a ring draws no figure lines", !layout.edges.some((e) => ch.cluster.contactIds.includes(e.source)));
  check("ring members are figure stars", ch.cluster.contactIds.every((id) => (star(id).figureRole === "figure")));
  const ringR = ch.cluster.contactIds.map((id) => posById.get(id)!);
  const cx = ringR.reduce((s, p) => s + p.x, 0) / ringR.length;
  const cy = ringR.reduce((s, p) => s + p.y, 0) / ringR.length;
  const radii = ringR.map((p) => Math.hypot(p.x - cx, p.y - cy));
  check(`ring members lie on one circle (spread ${(Math.max(...radii) - Math.min(...radii)).toFixed(1)}px)`, Math.max(...radii) - Math.min(...radii) < 3);
  // On its own the circle check would pass with every member stacked at the centre.
  const meanRadius = radii.reduce((a, b) => a + b, 0) / radii.length;
  check(`…and the circle is open, not collapsed (mean radius ${meanRadius.toFixed(0)}px ≥ ${RING_MIN_RADIUS})`, meanRadius >= RING_MIN_RADIUS);
  const su = [...fit.fits.values()].find((f) => f.cluster.name === "State U")!;
  check("a school too big for its rings scatters the rest", su.scatterMemberIds.length === 52 - Math.min(52, RING_CAPACITY) && su.figureMemberIds.length === Math.min(52, RING_CAPACITY));
  const suFigure = su.figureMemberIds.map((id) => posById.get(id)!);
  const scx = suFigure.reduce((a, p) => a + p.x, 0) / suFigure.length;
  const scy = suFigure.reduce((a, p) => a + p.y, 0) / suFigure.length;
  const suOuter = Math.max(...suFigure.map((p) => Math.hypot(p.x - scx, p.y - scy)));
  const suNearest = Math.min(...su.scatterMemberIds.map((id) => Math.hypot(posById.get(id)!.x - scx, posById.get(id)!.y - scy)));
  check(
    `the overflow scatters outside the ring (nearest ${suNearest.toFixed(0)}px > outer radius ${suOuter.toFixed(0)}px)`,
    su.scatterMemberIds.length > 0 && suNearest > suOuter
  );

  // A petal company's family satellite is seated in its roomiest petal without belonging to it.
  {
    const titled = (i: number, title: string) =>
      contact(`gg${i}`, { company: "Google", title, orbitScore: 1 + (i % 5) });
    const titles = [
      ...["VP Engineering", "CTO", "Co-founder"],
      ...Array.from({ length: 10 }, () => "Software Engineer"),
      ...Array.from({ length: 8 }, () => "Product Designer"),
      ...Array.from({ length: 5 }, () => "Account Executive"),
    ];
    const gContacts = [...titles.map((t, i) => titled(i, t)), contact("gc-sat", { company: "Google Cloud", orbitScore: 3 })];
    const gFit = buildConstellationFit(gContacts);
    const gLayout = buildHybridGraphLayout(gContacts, "Tester");
    const gPos = new Map(gLayout.nodes.filter((n) => n.type === "contact").map((n) => [n.id, n.position]));
    const google = [...gFit.fits.values()].find((f) => f.cluster.name === "Google")!;
    check("a titled 26-person Google splits into petals", google.form === "petal" && google.parts.length >= 3);
    const sat = gLayout.nodes.find((n) => n.id === "gc-sat")!.data as GraphNodeData;
    check("the Google Cloud satellite carries no part", sat.partKey === undefined && sat.partRole === undefined && sat.leader === undefined);
    const centroid = (ids: string[]) => ({
      x: ids.reduce((a, id) => a + gPos.get(id)!.x, 0) / ids.length,
      y: ids.reduce((a, id) => a + gPos.get(id)!.y, 0) / ids.length,
    });
    const core = google.parts.find((p) => p.role === "core")!;
    const roomiest = google.parts
      .filter((p) => p.role === "petal")
      .reduce((best, p) => (p.figureMemberIds.length + p.scatterMemberIds.length > best.figureMemberIds.length + best.scatterMemberIds.length ? p : best));
    const at = gPos.get("gc-sat")!;
    const dTo = (part: typeof core) => {
      const c = centroid([...part.figureMemberIds, ...part.scatterMemberIds]);
      return Math.hypot(at.x - c.x, at.y - c.y);
    };
    check(
      `…and sits nearer the roomiest petal (${roomiest.key}, ${dTo(roomiest).toFixed(0)}px) than the core (${dTo(core).toFixed(0)}px)`,
      dTo(roomiest) < dTo(core)
    );
  }

  // What the renderers draw: forms, part disks, per-star tints, line styles, petal names.
  {
    const nebula = (name: string) =>
      layout.nodes.find((n) => n.type === "nebula" && (n.data as NebulaData).company === name)!.data as NebulaData;
    check(
      "nebulae carry their cluster's form",
      nebula("Northwind").form === "petal" && nebula("Chapel Hill").form === "ring" && nebula("Google").form === "figure"
    );
    const nwParts = nebula("Northwind").parts!;
    check(
      "a petal nebula lists its parts, absolute and inside the sky",
      nwParts.map((p) => p.key).join() === "core,petal:engineering,petal:design,petal:sales" &&
        nwParts.every((p) => p.radius > 0 && Number.isFinite(p.x) && Number.isFinite(p.y))
    );
    check(
      "…and every part disk contains its stars",
      nw.parts.every((p, i) =>
        [...p.figureMemberIds, ...p.scatterMemberIds].every(
          (id) => Math.hypot(posById.get(id)!.x - nwParts[i].x, posById.get(id)!.y - nwParts[i].y) <= nwParts[i].radius + 1e-6
        )
      )
    );
    const chN = nebula("Chapel Hill");
    check(
      "a ring nebula has one part: the ring's centre and outer radius",
      chN.parts!.length === 1 &&
        chN.parts![0].key === "main" &&
        chN.parts![0].radius >= RING_MIN_RADIUS &&
        ch.cluster.contactIds.every(
          (id) => Math.hypot(posById.get(id)!.x - chN.parts![0].x, posById.get(id)!.y - chN.parts![0].y) <= chN.parts![0].radius + 1e-6
        )
    );
    check("figures and binaries have no parts", nebula("Google").parts === undefined);

    check("core stars are warm white", star("nw-l0").clusterColor === CORE_TINT);
    check(
      "petal stars keep the company's colour",
      star("nw-e0").clusterColor !== CORE_TINT && star("nw-e0").clusterColor === star("nw-d0").clusterColor
    );
    check(
      "figure stars anchor lines; ring stars do not",
      star("g0").anchorsLines === true && ch.cluster.contactIds.every((id) => star(id).anchorsLines === false)
    );
    const dashed = layout.edges.filter((e) => e.data?.dash);
    check(
      "role clusters draw dotted, faint lines",
      dashed.length > 0 &&
        dashed.every((e) => e.style?.strokeDasharray === "2 5" && Number(e.style?.opacity) === 0.35 && e.data?.reason === "role") &&
        layout.edges.filter((e) => e.data?.reason === "role").every((e) => e.data?.dash)
    );
    const coreIds = new Set(nw.parts.find((p) => p.role === "core")!.figureMemberIds);
    const coreEdges = layout.edges.filter((e) => coreIds.has(e.source) && coreIds.has(e.target));
    check("core lines are warm white", coreEdges.length > 0 && coreEdges.every((e) => /255,\s*233,\s*194/.test(String(e.style?.stroke))));

    // A petal's name sits below its lowest star (so it can never collide with the cluster name,
    // which sits above the topmost star), and the whole label fits inside the node's box. The
    // box's origin comes from the label node itself, the way a renderer finds it.
    const nwNode = layout.nodes.find((n) => n.type === "clusterLabel" && (n.data as ClusterLabelData).label === "Northwind")!;
    const box = label("Northwind").box!;
    const boxTop = nwNode.position.y - label("Northwind").anchor!.y;
    const petalOk = nw.parts
      .filter((p) => p.role !== "main")
      .every((p) => {
        const l = petalLabels.find((x) => x.key === p.key)!;
        const bottom = Math.max(...[...p.figureMemberIds, ...p.scatterMemberIds].map((id) => posById.get(id)!.y));
        return l.anchor.y + boxTop > bottom && l.anchor.y + PETAL_LABEL_HEIGHT <= box.height;
      });
    check("petal names sit below their part, inside the box", petalOk);
    const nwClash = petalNameOverlaps(layout);
    check(`no petal name lands on a star's name (Northwind fixture: ${nwClash.overlaps}/${nwClash.labels})`, nwClash.labels >= 4 && nwClash.overlaps === 0);
    {
      const big = buildHybridGraphLayout(buildSyntheticGraphPayload(2500, { seed: 1 }).contacts, "Tester");
      const clash = petalNameOverlaps(big);
      check(`…nor in a 2500-contact network (${clash.overlaps}/${clash.labels} overlap)`, clash.labels > 20 && clash.overlaps === 0);

      // Pulled back to 0.5 the star names grow (zoomRelief) and the petal names grow faster
      // (clusterNameScale), so the two meet. The petal names are registered with the star-name
      // pass first and win: a star whose name would land on one goes unnamed.
      const zoom = 0.5;
      const contacts = big.nodes.filter((n) => n.type === "contact");
      const petals = petalNameBoxes(
        big.nodes.filter((n) => n.type === "clusterLabel"),
        petalNameFontPx(clusterNameScale(zoom))
      );
      const hits = (boxes: LabelBox[], ids: Set<string>) =>
        contacts.filter((n) => ids.has(n.id)).filter((n) => {
          const b = starLabelBox(n, zoom);
          return boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
        }).length;
      const unregistered = hits(petals, starLabelWinners(contacts, zoom, () => false));
      const registered = hits(petals, starLabelWinners(contacts, zoom, () => false, petals));
      check(
        `at zoom 0.5 no star name wins a place on a petal name (${registered} with them registered, ${unregistered} without)`,
        petals.length > 20 && unregistered > 0 && registered === 0
      );
      const someHit = contacts.find((n) => {
        const b = starLabelBox(n, zoom);
        return petals.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
      })!;
      check(
        "…but a search hit still beats a petal name",
        starLabelWinners(contacts, zoom, (id) => id === someHit.id, petals).has(someHit.id)
      );
    }

    // A role cluster: each star wears its own company's colour; the label says how many companies.
    const rolePair = ["r1", "r2"].map((id) => star(id));
    check("role cluster stars wear their own company's colour", rolePair[0].clusterKind === "role" && rolePair[0].clusterColor !== rolePair[1].clusterColor);
    check("the role cluster's label counts its companies", label("Engineers").subtitle === "across 2 companies");
    const pm = layout.nodes.filter((n) => n.id === "pm1" || n.id === "pm2").map((n) => n.data as GraphNodeData);
    check(
      "a role cluster whose people have no company carries no subtitle",
      pm.length === 2 && pm[0].clusterKind === "role" && pm[0].clusterId === pm[1].clusterId &&
        label(pm[0].clusterName!).subtitle === undefined
    );
    check("only role clusters carry a subtitle", label("Google").subtitle === undefined && label("Northwind").subtitle === undefined);
  }
}

// ---------------------------------------------------------------------------
console.log("\nThe galaxy");

{
  const g = layout.galaxy;
  check("the layout carries a galaxy", Boolean(g) && g.diskRadius > 0);
  check(
    "no ring node is emitted",
    !layout.nodes.some((n) => n.id === "rings" || (n.type as string) === "orbitRings")
  );
  const clusteredIds = new Set(
    [...fit.fits.values()].flatMap((f) => [...f.figureMemberIds, ...f.scatterMemberIds])
  );
  check(
    "every clustered star lies inside the disk",
    [...clusteredIds].every((id) => {
      const p = posById.get(id)!;
      return Math.hypot(p.x, p.y) <= g.diskRadius + 1e-6;
    })
  );
  const haloIds = ["solo", ...Array.from({ length: 7 }, (_, i) => `d${i}`)];
  check(
    "unaffiliated stars sit in the halo, beyond the disk",
    haloIds.every((id) => {
      const p = posById.get(id)!;
      return Math.hypot(p.x, p.y) >= g.diskRadius;
    })
  );
  check("the core is inside the disk", g.coreRadius <= g.diskRadius);
  check(
    "filaments join clusters that exist",
    g.filaments.every((f) => fit.fits.has(f.from) && fit.fits.has(f.to))
  );
}

// ---------------------------------------------------------------------------
console.log("\nNear = related (a realistic network)");

{
  const network = buildSyntheticGraphPayload(600, { seed: 3 }).contacts;
  const big = buildHybridGraphLayout(network, "Tester");
  const bigFit = buildConstellationFit(network);
  const eligible = bigFit.clusters.filter((c) => bigFit.fits.has(c.id));
  const links = buildClusterAffinity(network, bigFit.byContactId, eligible);
  const centre = new Map(
    big.nodes
      .filter((n) => n.type === "nebula")
      .map((n) => [(n.data as NebulaData).clusterId!, n.position] as const)
  );
  const d = (a: string, b: string) => {
    const A = centre.get(a)!;
    const B = centre.get(b)!;
    return Math.hypot(A.x - B.x, A.y - B.y);
  };
  const ids = [...centre.keys()];
  const all: number[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) all.push(d(ids[i], ids[j]));
  all.sort((a, b) => a - b);
  const median = all[Math.floor(all.length / 2)];
  const related = links.filter((l) => centre.has(l.a) && centre.has(l.b));
  const mean = related.reduce((s, l) => s + d(l.a, l.b), 0) / Math.max(1, related.length);
  check("the network has related clusters", related.length > 10, String(related.length));
  check(
    `related clusters sit closer than a typical pair (mean ${mean.toFixed(0)} < median ${median.toFixed(0)})`,
    mean < median
  );

  // Same network, contacts the other way round: every star lands exactly where it did.
  const flipped = buildHybridGraphLayout([...network].reverse(), "Tester");
  const at = (l: typeof big) =>
    new Map(l.nodes.filter((n) => n.type === "contact").map((n) => [n.id, n.position] as const));
  const forwardAt = at(big);
  const flippedAt = at(flipped);
  let worst = 0;
  for (const [id, p] of forwardAt) {
    const q = flippedAt.get(id)!;
    worst = Math.max(worst, Math.abs(p.x - q.x), Math.abs(p.y - q.y));
  }
  check(
    "the layout does not depend on contact order",
    forwardAt.size === flippedAt.size && worst < 1e-6,
    `largest move ${worst.toFixed(6)}px`
  );
  const shape = (l: typeof big) =>
    JSON.stringify([
      Math.round(l.galaxy.diskRadius),
      Math.round(l.galaxy.coreRadius),
      l.galaxy.filaments.map((f) => `${f.from}>${f.to}`),
    ]);
  check("nor does the galaxy's shape", shape(big) === shape(flipped));
}

// ---------------------------------------------------------------------------
console.log("\nNo label clashes within a cluster");

{
  // The figure scale rule is a circle test (FIGURE_STAR_MIN); names are LABEL_WIDTH x LABEL_HEIGHT
  // boxes, so a tilted pair could clear the circle and still have overlapping names.
  const network = buildSyntheticGraphPayload(2500, { seed: 1 }).contacts;
  const big = buildHybridGraphLayout(network, "Tester");
  const bigFit = buildConstellationFit(network);
  const byCluster = new Map<string, Array<{ id: string; x: number; y: number }>>();
  for (const n of big.nodes) {
    if (n.type !== "contact") continue;
    const ref = bigFit.byContactId.get(n.id);
    if (!ref) continue;
    let list = byCluster.get(ref.id);
    if (!list) byCluster.set(ref.id, (list = []));
    list.push({ id: n.id, x: n.position.x, y: n.position.y });
  }
  let clashes = 0;
  let first = "";
  for (const stars of byCluster.values()) {
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const dx = stars[i].x - stars[j].x;
        const dy = stars[i].y - stars[j].y;
        if (!(Math.abs(dx) >= LABEL_WIDTH || Math.abs(dy) >= LABEL_HEIGHT)) {
          clashes += 1;
          if (!first) first = `${stars[i].id}↔${stars[j].id}`;
        }
      }
    }
  }
  console.log(`  label clashes within clusters: ${clashes} (${byCluster.size} clusters)`);
  check(
    "no two stars in one cluster have overlapping name boxes",
    clashes === 0,
    `${clashes} clashes, first ${first}`
  );
}

// ---------------------------------------------------------------------------
console.log("\nA crowded halo stays close to the galaxy");

{
  // 500 people with nothing to cluster on, 400 in forty companies. The halo must hold all of
  // them without trailing off into the far sky: the home view frames the farthest star.
  const people: GraphContactInput[] = [
    ...Array.from({ length: 500 }, (_, i) => contact(`h${i}`)),
    ...Array.from({ length: 400 }, (_, i) =>
      contact(`k${i}`, { company: `Firm${i % 40} Works` })
    ),
  ];
  const crowd = buildHybridGraphLayout(people, "Tester");
  const disk = crowd.galaxy.diskRadius;
  const halo = crowd.nodes
    .filter((n) => n.type === "contact" && n.id.startsWith("h"))
    .map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, r: Math.hypot(n.position.x, n.position.y) }));
  const nearest = Math.min(...halo.map((h) => h.r));
  const farthest = Math.max(...halo.map((h) => h.r));
  check("the halo has its 500 stars", halo.length === 500, String(halo.length));
  check(
    "every halo star is beyond the disk and a gap",
    nearest >= disk + 80,
    `nearest ${nearest.toFixed(0)} vs disk ${disk.toFixed(0)}`
  );
  check(
    "the farthest halo star is within 1.6 disk radii",
    farthest <= 1.6 * disk,
    `farthest ${farthest.toFixed(0)} = ${(farthest / disk).toFixed(2)} x disk ${disk.toFixed(0)}`
  );
  let clash = 0;
  for (let i = 0; i < halo.length; i++) {
    for (let j = i + 1; j < halo.length; j++) {
      if (
        Math.abs(halo[i].x - halo[j].x) < LABEL_WIDTH &&
        Math.abs(halo[i].y - halo[j].y) < LABEL_HEIGHT
      ) {
        clash++;
      }
    }
  }
  check("no two halo labels overlap", clash === 0, `${clash} pairs`);
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

console.log("\nAll graph-layout smoke checks passed.\n");
process.exit(0);
