import {
  buildConstellationFit,
  constellationFitEdges,
  orderConstellationMembers,
  clampScore,
  placementScore,
  type ClusterFit,
} from "@/lib/constellation-fit";
import { isCometContact } from "@/lib/comet";
import { scaleForStarCount } from "@/lib/constellation-shapes";
import { type BuiltCluster, type ClusterKind } from "@/lib/constellation-clusters";
import { companyFamilyKey } from "@/lib/company-family";
import { peerEdgeToLayoutEdge, type PeerEdge } from "@/lib/network-metrics";
import {
  clusterBrandColor,
  mixWithWhite,
  withAlpha,
} from "@/lib/school-color";
import { hashUnit } from "@/lib/hash";

export { orderConstellationMembers };

/** Decorative orbit rings — pure background texture, no meaning. */
export const RING_RADII = [160, 260, 360, 470, 580] as const;

/** Score 5 = closest to you (the sun) … Score 1 = furthest out */
export const RING_LABELS: Record<number, string> = {
  5: "Core orbit",
  4: "Inner orbit",
  3: "Mid orbit",
  2: "Outer orbit",
  1: "Deep space",
};

export type GraphContactInput = {
  id: string;
  fullName: string;
  preferredName?: string | null;
  company: string | null;
  school?: string | null;
  title: string | null;
  relationshipScore: number;
  closeness?: number;
  closenessTier?: "inner" | "mid" | "outer";
  orbitScore?: number;
  lastInteractionAt: Date | string | null;
  nextFollowUpAt: Date | string | null;
  tags: string[];
  aiSummary: string | null;
  keyFacts: string[] | null;
  metContext?: string | null;
  dateMet?: Date | string | null;
  howMet?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  website?: string | null;
  profileImageUrl?: string | null;
  notes?: string | null;
  sharedInterests?: string[] | null;
  dormant?: boolean;
};

export type GraphNodeData = {
  kind: "user" | "contact";
  label: string;
  fullName?: string;
  preferredName?: string | null;
  initials: string;
  company?: string | null;
  school?: string | null;
  title?: string | null;
  score?: number;
  relationshipScore?: number;
  closeness?: number;
  closenessTier?: "inner" | "mid" | "outer";
  comet?: boolean;
  overdue?: boolean;
  tags?: string[];
  aiSummary?: string | null;
  keyFacts?: string[];
  lastInteractionAt?: string | null;
  nextFollowUpAt?: string | null;
  metContext?: string | null;
  dateMet?: string | null;
  howMet?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  website?: string | null;
  profileImageUrl?: string | null;
  clusterId?: string;
  clusterName?: string;
  clusterKind?: ClusterKind;
  /** Whether this star traces the constellation figure or scatters around it. */
  figureRole?: "figure" | "scatter";
  /** Brand color of the star's cluster (undefined for Deep Space singletons). */
  clusterColor?: string;
  orbitAngle?: number;
  orbitRadius?: number;
  spotlight?: boolean;
  /** The one-and-only search hit — bobs gently so the eye lands on it. */
  spotlightSolo?: boolean;
  motionPaused?: boolean;
};

export type OrbitRingsData = {
  kind: "rings";
  radii: number[];
  showLabels?: boolean;
};

export type ClusterLabelData = {
  kind: "clusterLabel";
  label: string;
  count?: number;
  nebulaColor?: string;
  clusterKind?: ClusterKind;
  clusterId?: string;
};

export type NebulaData = {
  kind: "nebula";
  company: string;
  color: string;
  radius: number;
  clusterKind?: ClusterKind;
  clusterId?: string;
};

export type LayoutNode = {
  id: string;
  type: "user" | "contact" | "orbitRings" | "clusterLabel" | "nebula";
  data: GraphNodeData | OrbitRingsData | ClusterLabelData | NebulaData;
  position: { x: number; y: number };
  draggable?: boolean;
  selectable?: boolean;
  zIndex?: number;
};

export type EdgeKind = "solar" | "constellation" | "knows";

export type LayoutEdge = {
  id: string;
  source: string;
  target: string;
  type: "straight" | "labeled";
  animated?: boolean;
  label?: string;
  data?: {
    kind: EdgeKind;
    company?: string;
    reason?:
      | "company"
      | "school"
      | "event"
      | "howMet"
      | "mention"
      | "sharedTags"
      | "sharedInterests";
    label?: string;
    brandColor?: string;
  };
  style?: Record<string, string | number>;
};

export function displayName(c: {
  fullName: string;
  preferredName?: string | null;
}) {
  const preferred = (c.preferredName || "").trim();
  return preferred || c.fullName;
}

export function initialsFromName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.toISOString();
}

function isOverdue(nextFollowUpAt: Date | string | null | undefined) {
  if (!nextFollowUpAt) return false;
  const d =
    typeof nextFollowUpAt === "string"
      ? new Date(nextFollowUpAt)
      : nextFollowUpAt;
  return d.getTime() < Date.now();
}

type PolarPosition = { x: number; y: number; angle: number; radius: number };

function toPosition(x: number, y: number): PolarPosition {
  return { x, y, angle: Math.atan2(y, x), radius: Math.hypot(x, y) };
}

/**
 * Every star carries an always-visible name + role label (see
 * graph-nodes.tsx), so spacing is driven by label size rather than star
 * size: LABEL_WIDTH horizontally, LABEL_HEIGHT vertically.
 */
const LABEL_WIDTH = 104;
const LABEL_HEIGHT = 30;

/** Clear sky between the sun and the first shell's clusters. */
const SUN_CLEAR = 180;
/** Minimum clearance between two cluster footprints. */
const CLUSTER_GAP = LABEL_WIDTH;
/** Scatter field starts this far beyond the figure's extent. */
const SCATTER_CLEAR = 54;
/** Initial width of a cluster's scatter field annulus. */
const SCATTER_FIELD_WIDTH = 110;
/** Headroom beyond the outermost scatter star inside the footprint. */
const FOOT_MARGIN = 34;
/** Gap between the last shell and the deep-space rim. */
const BACKGROUND_GAP = 90;
/** Initial width of the deep-space rim annulus. */
const BACKGROUND_FIELD_WIDTH = 160;
/** Minimum distance between any two figure stars after scaling. */
const FIGURE_STAR_MIN = LABEL_WIDTH;
/** How far a tight template may be upscaled to clear FIGURE_STAR_MIN. */
const FIGURE_MAX_UPSCALE = 2.4;

/**
 * Two stars may not sit inside each other's label boxes: they need either
 * horizontal room for a label, or enough vertical room that a label clears
 * the star below it.
 */
const LABEL_CLEAR_X = LABEL_WIDTH + 8;
const LABEL_CLEAR_Y = LABEL_HEIGHT + 14;

function labelClear(
  a: { x: number; y: number },
  b: { x: number; y: number }
) {
  return (
    Math.abs(a.x - b.x) >= LABEL_CLEAR_X || Math.abs(a.y - b.y) >= LABEL_CLEAR_Y
  );
}

/**
 * Scatter members organically through an annulus — no rings, no lattice.
 * Seeded rejection sampling: each member tries hash-driven spots until one
 * clears every already-placed star's label box; when an annulus fills up it
 * widens and the sampling continues. Deterministic and guaranteed to leave
 * breathing room between nodes.
 */
function scatterField(
  ids: string[],
  seedPrefix: string,
  inner: number,
  initialWidth: number,
  avoid: Array<{ x: number; y: number }>
): { placed: Array<{ id: string; x: number; y: number }>; outer: number } {
  const placed: Array<{ id: string; x: number; y: number }> = [];
  let outer = inner + initialWidth;

  for (const id of ids) {
    let spot: { x: number; y: number } | null = null;
    let attempt = 0;
    let rounds = 0;
    while (!spot && rounds < 200) {
      for (let tries = 0; tries < 24 && !spot; tries++, attempt++) {
        const u = hashUnit(`${seedPrefix}:${id}`, attempt * 2 + 1);
        const v = hashUnit(`${seedPrefix}:${id}`, attempt * 2 + 2);
        const angle = u * Math.PI * 2;
        // sqrt() → uniform density over the annulus
        const radius = Math.sqrt(
          inner * inner + v * (outer * outer - inner * inner)
        );
        const candidate = {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        };
        if (
          avoid.every((p) => labelClear(candidate, p)) &&
          placed.every((p) => labelClear(candidate, p))
        ) {
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
  }

  const maxR = placed.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.y)), inner);
  return { placed, outer: Math.max(outer, maxR) };
}

/** One cluster's local geometry: undistorted figure plus a scatter field. */
export type ClusterGeometry = {
  cluster: BuiltCluster;
  fit: ClusterFit;
  /** Rotated, scaled shape stars in cluster-local space (index ↔ figureMemberIds). */
  figureLocal: Array<{ x: number; y: number }>;
  figureExtent: number;
  /** Overflow members scattered organically around the figure, cluster-local. */
  scatterLocal: Array<{ id: string; x: number; y: number }>;
  /** Footprint radius: everything the cluster draws stays inside this disk. */
  foot: number;
};

/**
 * Build a cluster's local geometry. The asterism renders at its natural
 * scale with a mild seeded tilt — never warped — and is scaled up further
 * only if a template packs two stars closer than FIGURE_STAR_MIN. Overflow
 * members scatter organically through an annulus fully outside the figure's
 * extent, which guarantees clearance from every figure star and line by
 * construction.
 */
export function buildClusterGeometry(fit: ClusterFit): ClusterGeometry {
  const { shape, figureMemberIds, scatterMemberIds, cluster } = fit;
  const count = figureMemberIds.length;
  const baseScale = scaleForStarCount(count);
  let scale = baseScale;
  const rotation = (hashUnit(cluster.id, 11) - 0.5) * Math.PI * 0.5;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const stars = shape.stars.slice(0, count);
  if (count > 1) {
    let minDist = Infinity;
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        minDist = Math.min(
          minDist,
          Math.hypot(stars[i].x - stars[j].x, stars[i].y - stars[j].y)
        );
      }
    }
    if (minDist > 0 && minDist * scale < FIGURE_STAR_MIN) {
      // Open the figure up until its tightest pair clears a label, but never
      // so far that one cluster swallows the sky.
      scale = Math.min(FIGURE_STAR_MIN / minDist, baseScale * FIGURE_MAX_UPSCALE);
    }
  }

  const figureLocal = stars.map((s) => ({
    x: (s.x * cos - s.y * sin) * scale,
    y: (s.x * sin + s.y * cos) * scale,
  }));
  const figureExtent = figureLocal.reduce(
    (m, p) => Math.max(m, Math.hypot(p.x, p.y)),
    scale * 0.3
  );

  const { placed: scatterLocal, outer } = scatterField(
    scatterMemberIds,
    cluster.id,
    figureExtent + SCATTER_CLEAR,
    SCATTER_FIELD_WIDTH,
    figureLocal
  );
  const outermost = scatterLocal.length > 0 ? outer : figureExtent;

  return {
    cluster,
    fit,
    figureLocal,
    figureExtent,
    scatterLocal,
    foot: outermost + FOOT_MARGIN,
  };
}

/** Family-adjacent cluster order: families by total size, members by size. */
function orderClustersByFamily(eligible: BuiltCluster[]): BuiltCluster[] {
  const families = new Map<string, BuiltCluster[]>();
  for (const cluster of eligible) {
    const key =
      cluster.kind === "company"
        ? companyFamilyKey(cluster.name) || cluster.id
        : cluster.id;
    const list = families.get(key);
    if (list) list.push(cluster);
    else families.set(key, [cluster]);
  }
  return [...families.entries()]
    .map(([key, clusters]) => ({
      key,
      clusters: [...clusters].sort(
        (a, b) => b.count - a.count || a.id.localeCompare(b.id)
      ),
      total: clusters.reduce((s, c) => s + c.count, 0),
    }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))
    .flatMap((f) => f.clusters);
}

export type PackedShells = {
  /** Cluster centers, keyed by cluster id. */
  centers: Map<string, { x: number; y: number }>;
  /** Outer edge of the packed sky (last shell radius + its max footprint + gap). */
  skyEdge: number;
  /** Family-adjacent order used for packing. */
  ordered: ClusterGeometry[];
};

/** Exact angular need between two adjacent clusters on a shell of radius R. */
function pairArc(a: ClusterGeometry, b: ClusterGeometry, R: number) {
  return (
    2 * Math.asin(Math.min(1, (a.foot + b.foot + CLUSTER_GAP) / (2 * R)))
  );
}

function shellFits(items: ClusterGeometry[], R: number) {
  if (items.length <= 1) return true;
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += pairArc(items[i], items[(i + 1) % items.length], R);
  }
  return total <= Math.PI * 2;
}

/**
 * Pack clusters onto concentric shells around the sun. Greedy fill in
 * family-adjacent order: a shell accepts clusters while the exact chord-based
 * angular budget lasts, then the next shell starts beyond the previous
 * shell's outer edge. Adjacent-slot arcs are exact chord constraints and
 * shells are radially disjoint, so cluster footprints never overlap.
 */
export function packClusterShells(geoms: ClusterGeometry[]): PackedShells {
  const centers = new Map<string, { x: number; y: number }>();
  let prevOuter = SUN_CLEAR;
  let idx = 0;
  let shellIndex = 0;

  while (idx < geoms.length) {
    const items: ClusterGeometry[] = [];
    let maxFoot = 0;
    let R = 0;
    while (idx < geoms.length) {
      const tentative = [...items, geoms[idx]];
      const tentativeMax = Math.max(maxFoot, geoms[idx].foot);
      const tentativeR = prevOuter + tentativeMax + (shellIndex > 0 ? CLUSTER_GAP : 0);
      if (items.length > 0 && !shellFits(tentative, tentativeR)) break;
      items.push(geoms[idx]);
      maxFoot = tentativeMax;
      R = tentativeR;
      idx++;
    }

    // Place along the shell: exact pairwise increments plus even slack.
    const start = -Math.PI / 2 + shellIndex * 0.6;
    if (items.length === 1) {
      centers.set(items[0].cluster.id, {
        x: Math.cos(start) * R,
        y: Math.sin(start) * R,
      });
    } else {
      const increments = items.map((g, i) =>
        pairArc(g, items[(i + 1) % items.length], R)
      );
      const used = increments.reduce((a, b) => a + b, 0);
      const slack = Math.max(0, Math.PI * 2 - used) / items.length;
      let theta = start;
      items.forEach((g, i) => {
        centers.set(g.cluster.id, {
          x: Math.cos(theta) * R,
          y: Math.sin(theta) * R,
        });
        theta += increments[i] + slack;
      });
    }

    prevOuter = R + maxFoot + CLUSTER_GAP;
    shellIndex += 1;
  }

  return { centers, skyEdge: prevOuter, ordered: geoms };
}

/**
 * The packed sky atlas:
 * - Sun at the center inside a clear core.
 * - Each company/school cluster draws its asterism, undistorted, with
 *   overflow members ringed around it; clusters pack on concentric shells
 *   with guaranteed spacing.
 * - Deep Space and singletons rim the sky beyond the last shell.
 * - Nothing overlaps: stars, figures, and lines all keep their distance.
 */
export function buildHybridGraphLayout(
  contacts: GraphContactInput[],
  userName: string
): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const fit = buildConstellationFit(contacts);
  const { byContactId, fits } = fit;

  const eligible = fit.clusters.filter((c) => fits.has(c.id));
  const geoms = orderClustersByFamily(eligible).map((cluster) =>
    buildClusterGeometry(fits.get(cluster.id)!)
  );
  const { centers, skyEdge } = packClusterShells(geoms);

  const positions = new Map<string, PolarPosition>();
  const figureIds = new Set<string>();

  for (const geom of geoms) {
    const center = centers.get(geom.cluster.id)!;

    geom.fit.figureMemberIds.forEach((id, i) => {
      const p = geom.figureLocal[i] || { x: 0, y: 0 };
      figureIds.add(id);
      positions.set(id, toPosition(center.x + p.x, center.y + p.y));
    });

    for (const p of geom.scatterLocal) {
      positions.set(p.id, toPosition(center.x + p.x, center.y + p.y));
    }
  }

  // Deep Space and singleton clusters scatter across the rim beyond the
  // last shell — same organic field, sky-sized.
  const background = contacts
    .filter((c) => !positions.has(c.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (background.length > 0) {
    const { placed } = scatterField(
      background.map((c) => c.id),
      "deep-space",
      skyEdge + BACKGROUND_GAP,
      BACKGROUND_FIELD_WIDTH,
      []
    );
    for (const p of placed) {
      positions.set(p.id, toPosition(p.x, p.y));
    }
  }

  const clusterNodes: LayoutNode[] = [];
  const clusterColorById = new Map<string, string>();
  for (const geom of geoms) {
    const cluster = geom.cluster;
    const center = centers.get(cluster.id)!;
    const color = clusterBrandColor(cluster.name, cluster.kind);
    clusterColorById.set(cluster.id, color);

    const memberPositions = cluster.contactIds
      .map((id) => positions.get(id))
      .filter((p): p is PolarPosition => Boolean(p));
    if (memberPositions.length === 0) continue;

    const cx =
      memberPositions.reduce((s, p) => s + p.x, 0) / memberPositions.length;
    const cy =
      memberPositions.reduce((s, p) => s + p.y, 0) / memberPositions.length;
    const starExtent = memberPositions.reduce(
      (m, p) => Math.max(m, Math.hypot(p.x - cx, p.y - cy)),
      80
    );
    const nebulaRadius = Math.max(90, starExtent + 70);

    clusterNodes.push({
      id: `nebula-${cluster.id}`,
      type: "nebula",
      data: {
        kind: "nebula",
        company: cluster.name,
        color,
        radius: nebulaRadius,
        clusterKind: cluster.kind,
        clusterId: cluster.id,
      },
      position: { x: cx, y: cy },
      draggable: false,
      selectable: true,
      zIndex: 0,
    });

    // Label just outside the footprint, away from the sun — it lands in the
    // guaranteed gap between shells.
    const centerAngle = Math.atan2(center.y, center.x);
    const labelRadius = Math.hypot(center.x, center.y) + geom.foot;
    clusterNodes.push({
      id: `cluster-${cluster.id}`,
      type: "clusterLabel",
      data: {
        kind: "clusterLabel",
        label: cluster.name,
        count: cluster.count,
        nebulaColor: color,
        clusterKind: cluster.kind,
        clusterId: cluster.id,
      },
      position: {
        x: Math.cos(centerAngle) * labelRadius,
        y: Math.sin(centerAngle) * labelRadius,
      },
      draggable: false,
      selectable: true,
      zIndex: 7,
    });
  }

  const nodes: LayoutNode[] = [
    {
      id: "rings",
      type: "orbitRings",
      data: {
        kind: "rings",
        radii: [...RING_RADII],
        showLabels: false,
      },
      position: { x: 0, y: 0 },
      draggable: false,
      selectable: false,
      zIndex: -2,
    },
    {
      id: "me",
      type: "user",
      data: {
        kind: "user",
        label: userName || "You",
        initials: initialsFromName(userName || "You"),
      },
      position: { x: 0, y: 0 },
      draggable: false,
      zIndex: 10,
    },
    ...clusterNodes,
    ...contacts.map((c) => {
      const pos = positions.get(c.id) || toPosition(0, 320);
      const score = placementScore(c);
      const dormant = c.dormant === true || isCometContact(c.lastInteractionAt);
      const name = displayName(c);
      const cluster = byContactId.get(c.id);
      return {
        id: c.id,
        type: "contact" as const,
        data: {
          kind: "contact" as const,
          label: name,
          fullName: c.fullName,
          preferredName: c.preferredName,
          initials: initialsFromName(name),
          company: c.company,
          school: c.school ?? null,
          title: c.title,
          score,
          relationshipScore: clampScore(c.relationshipScore),
          closeness: c.closeness,
          closenessTier: c.closenessTier,
          comet: dormant,
          overdue: isOverdue(c.nextFollowUpAt),
          tags: c.tags,
          aiSummary: c.aiSummary,
          keyFacts: c.keyFacts || [],
          lastInteractionAt: toIso(c.lastInteractionAt),
          nextFollowUpAt: toIso(c.nextFollowUpAt),
          metContext: c.metContext ?? null,
          dateMet: toIso(c.dateMet ?? null),
          howMet: c.howMet ?? null,
          email: c.email ?? null,
          phone: c.phone ?? null,
          linkedinUrl: c.linkedinUrl ?? null,
          website: c.website ?? null,
          profileImageUrl: c.profileImageUrl ?? null,
          clusterId: cluster?.id,
          clusterName: cluster?.name,
          clusterKind: cluster?.kind,
          figureRole: figureIds.has(c.id)
            ? ("figure" as const)
            : ("scatter" as const),
          clusterColor: cluster ? clusterColorById.get(cluster.id) : undefined,
          orbitAngle: pos.angle,
          orbitRadius: pos.radius,
        },
        position: { x: pos.x, y: pos.y },
        zIndex: dormant ? 6 : 5,
      };
    }),
  ];

  // Constellation path edges only — brand-tinted lines along each figure,
  // synthesized from the same fit that placed the stars.
  const edges: LayoutEdge[] = [];
  for (const fitEdge of constellationFitEdges(fit)) {
    const reason = fitEdge.clusterKind === "school" ? "school" : "company";
    const peer: PeerEdge = {
      source: fitEdge.source,
      target: fitEdge.target,
      kind: "constellation",
      reason,
      company: fitEdge.clusterName,
    };
    const layoutEdge = peerEdgeToLayoutEdge(peer);
    const brand = clusterBrandColor(fitEdge.clusterName, reason);
    edges.push({
      ...layoutEdge,
      type: "labeled",
      label: undefined,
      style: {
        ...layoutEdge.style,
        stroke: withAlpha(mixWithWhite(brand, 0.55), 0.8),
      },
      data: layoutEdge.data
        ? {
            kind: layoutEdge.data.kind,
            company: layoutEdge.data.company,
            reason: layoutEdge.data.reason,
            brandColor: brand,
          }
        : undefined,
    });
  }

  return { nodes, edges };
}
