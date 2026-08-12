import { isCometContact } from "@/lib/comet";
import {
  buildConstellationClusters,
  type ClusterKind,
} from "@/lib/constellation-clusters";
import {
  resolveConstellationShape,
  scaleForStarCount,
  constellationFootprint,
  assignClusterShapes,
  figureStarCount,
  scatterFieldFactor,
} from "@/lib/constellation-shapes";
import { buildPeerEdges, peerEdgeToLayoutEdge } from "@/lib/network-metrics";
import {
  clusterBrandColor,
  mixWithWhite,
  withAlpha,
} from "@/lib/school-color";

/** Decorative orbit rings (visual grid only — no spokes). */
export const RING_RADII = [160, 260, 360, 470, 580] as const;

/** Vertical squash for the galactic disk (spiral arms + rings). */
export const GALAXY_FLATTEN = 0.54;

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
  motionPaused?: boolean;
};

export type OrbitRingsData = {
  kind: "rings";
  radii: number[];
  showLabels?: boolean;
  /** Vertical scale for an elliptical galactic disk (1 = circle). */
  flatten?: number;
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

export type ArmGlowData = {
  kind: "armGlow";
  /** Unflattened polyline per spiral arm; the renderer applies the disk flatten. */
  arms: Array<Array<{ x: number; y: number }>>;
  flatten: number;
};

export type LayoutNode = {
  id: string;
  type: "user" | "contact" | "orbitRings" | "clusterLabel" | "nebula" | "armGlow";
  data:
    | GraphNodeData
    | OrbitRingsData
    | ClusterLabelData
    | NebulaData
    | ArmGlowData;
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

function clampScore(score: number | null | undefined) {
  return Math.min(5, Math.max(1, score || 2));
}

function placementScore(c: GraphContactInput) {
  return clampScore(c.orbitScore ?? c.relationshipScore);
}

function isDormantContact(c: GraphContactInput) {
  return c.dormant === true || isCometContact(c.lastInteractionAt);
}

/**
 * Stable order for constellation star placement and path edges.
 * Dormant contacts sort last so figures are traced by active, closest people;
 * in clusters above the figure cap they demote to the scatter field.
 */
export function orderConstellationMembers(members: GraphContactInput[]) {
  return [...members].sort((a, b) => {
    const dormantDiff = (isDormantContact(a) ? 1 : 0) - (isDormantContact(b) ? 1 : 0);
    if (dormantDiff !== 0) return dormantDiff;
    const scoreDiff = placementScore(b) - placementScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return displayName(a).localeCompare(displayName(b));
  });
}

export function ringRadiusForScore(score: number) {
  const s = clampScore(score);
  return RING_RADII[5 - s];
}

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

function hashUnit(id: string, salt = 0) {
  let h = salt * 2654435761;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return (h % 10000) / 10000;
}

/**
 * Fill the cluster's scatter field: members beyond the figure cap become
 * fainter background stars on a seeded uniform disk around the figure.
 * Deterministic, with two bounded passes pushing scatter off figure stars
 * and off the figure's line segments so the shape stays readable.
 */
function placeScatterMembers(
  members: GraphContactInput[],
  origin: { x: number; y: number },
  positions: Map<string, { x: number; y: number; angle: number; radius: number }>,
  opts: {
    scale: number;
    fieldRadius: number;
    /** Rotated figure-star points in cluster-local space (post dormant nudge). */
    figureLocal: Array<{ x: number; y: number }>;
    figureEdges: Array<[number, number]>;
  }
) {
  const { scale, fieldRadius, figureLocal, figureEdges } = opts;
  const inner = scale * 0.3;
  const STAR_MIN_DIST = 26;
  const LINE_MIN_DIST = 14;

  for (const c of members) {
    const dormant = isDormantContact(c);
    const theta = hashUnit(c.id, 21) * Math.PI * 2;
    // sqrt() → uniform density over the disk; comets rim the outer band.
    const radius = dormant
      ? scale * (0.85 + hashUnit(c.id, 22) * 0.3)
      : inner + Math.sqrt(hashUnit(c.id, 22)) * Math.max(fieldRadius - inner, 20);
    let lx = Math.cos(theta) * radius;
    let ly = Math.sin(theta) * radius;

    for (let pass = 0; pass < 2; pass++) {
      for (const p of figureLocal) {
        const dx = lx - p.x;
        const dy = ly - p.y;
        const d = Math.hypot(dx, dy);
        if (d >= STAR_MIN_DIST) continue;
        const push = STAR_MIN_DIST - d;
        const ux = d > 0.001 ? dx / d : Math.cos(theta);
        const uy = d > 0.001 ? dy / d : Math.sin(theta);
        lx += ux * push;
        ly += uy * push;
      }
      for (const [ai, bi] of figureEdges) {
        const a = figureLocal[ai];
        const b = figureLocal[bi];
        if (!a || !b) continue;
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const len2 = abx * abx + aby * aby;
        const t =
          len2 > 0
            ? Math.max(0, Math.min(1, ((lx - a.x) * abx + (ly - a.y) * aby) / len2))
            : 0;
        const dx = lx - (a.x + abx * t);
        const dy = ly - (a.y + aby * t);
        const d = Math.hypot(dx, dy);
        if (d >= LINE_MIN_DIST) continue;
        const push = LINE_MIN_DIST - d;
        const norm = Math.sqrt(len2) || 1;
        const ux = d > 0.001 ? dx / d : -aby / norm;
        const uy = d > 0.001 ? dy / d : abx / norm;
        lx += ux * push;
        ly += uy * push;
      }
    }

    if (dormant) {
      const away = Math.atan2(origin.y, origin.x) || theta;
      lx += Math.cos(away) * 48;
      ly += Math.sin(away) * 48;
    }

    const x = origin.x + lx;
    const y = origin.y + ly;
    positions.set(c.id, {
      x,
      y,
      angle: Math.atan2(y, x),
      radius: Math.hypot(x, y),
    });
  }
}

/**
 * Map cluster members onto a real constellation figure (Cassiopeia, Orion, …).
 * The top members (by placement order) trace the figure; the rest scatter as
 * fainter background stars around it. `armRotation` aligns the figure with
 * the galactic arm it sits on.
 */
function placeConstellationMembers(
  members: GraphContactInput[],
  origin: { x: number; y: number },
  clusterSeed: string,
  positions: Map<string, { x: number; y: number; angle: number; radius: number }>,
  shape = resolveConstellationShape(figureStarCount(members.length), clusterSeed),
  armRotation?: number,
  figureIds?: Set<string>
) {
  const sorted = orderConstellationMembers(members);
  const n = sorted.length;
  if (n === 0) return;

  const figureCount = Math.min(shape.stars.length, n);
  const scale = scaleForStarCount(figureCount);
  // Prefer arm tangent so mini-galaxies flow with the larger spiral;
  // fall back to a mild seeded tilt when no arm angle is given.
  const rotation =
    armRotation ?? (hashUnit(clusterSeed, 11) - 0.5) * Math.PI * 0.25;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const figureLocal: Array<{ x: number; y: number }> = [];
  sorted.slice(0, figureCount).forEach((c, i) => {
    const star = shape.stars[i] || { x: 0, y: 0 };
    let lx = (star.x * cos - star.y * sin) * scale;
    let ly = (star.x * sin + star.y * cos) * scale;

    if (isDormantContact(c)) {
      const away = Math.atan2(origin.y, origin.x) || rotation;
      lx += Math.cos(away) * 48;
      ly += Math.sin(away) * 48;
    }

    figureLocal.push({ x: lx, y: ly });
    figureIds?.add(c.id);

    const x = origin.x + lx;
    const y = origin.y + ly;
    positions.set(c.id, {
      x,
      y,
      angle: Math.atan2(y, x),
      radius: Math.hypot(x, y),
    });
  });

  if (n > figureCount) {
    placeScatterMembers(sorted.slice(figureCount), origin, positions, {
      scale,
      fieldRadius: scale * scatterFieldFactor(n),
      figureLocal,
      figureEdges: shape.edges,
    });
  }
}

/**
 * Constellation map:
 * - Sun at the galactic center
 * - Faint orbit rings as spatial grid
 * - Clusters arranged on a flattened multi-arm spiral galaxy
 * - Peer constellation links within clusters
 */
export function buildHybridGraphLayout(
  contacts: GraphContactInput[],
  userName: string
): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const { clusters, byContactId } = buildConstellationClusters(contacts);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));

  const byCluster = new Map<string, GraphContactInput[]>();
  for (const cluster of clusters) {
    const members = cluster.contactIds
      .map((id) => contactsById.get(id))
      .filter(Boolean) as GraphContactInput[];
    byCluster.set(cluster.id, members);
  }

  const clusterOrigins = new Map<string, { x: number; y: number }>();
  const clusterArmAngle = new Map<string, number>();
  const named = clusters.filter((c) => c.kind !== "other" || c.count >= 1);
  // Same assignment order as buildPeerEdges so lines match star figures
  const clusterShapes = assignClusterShapes(
    clusters.map((c) => ({ id: c.id, contactIds: c.contactIds }))
  );

  type Slot = {
    id: string;
    foot: number;
    arm: number;
    step: number;
    angle: number;
    radius: number;
    /** Screen-space position after disk flatten */
    x: number;
    y: number;
  };

  // Biggest / closest clusters near the bulge; stable tie-break on id.
  const ordered = [...named].sort((a, b) => {
    const ma = byCluster.get(a.id) || [];
    const mb = byCluster.get(b.id) || [];
    if (mb.length !== ma.length) return mb.length - ma.length;
    const sa =
      ma.reduce((s, c) => s + placementScore(c), 0) / Math.max(ma.length, 1);
    const sb =
      mb.reduce((s, c) => s + placementScore(c), 0) / Math.max(mb.length, 1);
    if (sb !== sa) return sb - sa;
    return a.id.localeCompare(b.id);
  });

  // Classic spiral-galaxy silhouette: 2–4 logarithmic arms on a tilted disk.
  // Spread clusters across a 6-arm spiral galaxy.
  // If there are fewer clusters than arms, we still keep the math valid by capping.
  const armCount = Math.min(6, Math.max(1, ordered.length));
  const flatten = GALAXY_FLATTEN;
  const wind = 4.9; // stronger sweep from core to rim
  const coreGap = 250;
  const rimExtra = 720;
  const maxStep = Math.max(1, Math.ceil(ordered.length / armCount) - 1);
  const globalSpin = -Math.PI / 2; // open an arm upward for the default view

  const slots: Slot[] = ordered.map((cluster, i) => {
    const members = byCluster.get(cluster.id) || [];
    const size = members.length;
    const foot = constellationFootprint(size);
    const arm = i % armCount;
    const step = Math.floor(i / armCount);
    const t = maxStep === 0 ? 0 : step / maxStep;

    // Logarithmic-style spiral: angle winds while radius grows with t.
    const armBase = (arm * Math.PI * 2) / armCount;
    const jitter =
      (hashUnit(cluster.id, 12) - 0.5) * 0.12 +
      (hashUnit(cluster.id, 8) - 0.5) * 0.04;
    const angle = globalSpin + armBase + t * wind + t * t * 0.9 + jitter;

    const sizeBoost = Math.min(size, 16) * 14;
    const band =
      cluster.kind === "company" ? 0 : cluster.kind === "school" ? 35 : 70;
    const radius =
      coreGap +
      t * (rimExtra + ordered.length * 34) +
      sizeBoost * 0.35 +
      band +
      hashUnit(cluster.id, 8) * 55;

    const r = Math.max(coreGap * 0.9, radius);
    return {
      id: cluster.id,
      foot,
      arm,
      step,
      angle,
      radius: r,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r * flatten,
    };
  });

  // Resolve collisions along each arm — push the outer cluster farther out
  // so the spiral silhouette stays intact.
  for (let iter = 0; iter < 8; iter++) {
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i];
        const b = slots[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const minDist = a.foot * 0.7 + b.foot * 0.7 + 160;
        if (dist >= minDist) continue;

        const move = b.step >= a.step ? b : a;
        const push = minDist - dist + 40;
        move.radius += push;
        // Keep walking the same arm (same chirality as wind)
        move.angle += (push / Math.max(move.radius, 1)) * 0.9;
        move.x = Math.cos(move.angle) * move.radius;
        move.y = Math.sin(move.angle) * move.radius * flatten;
      }
    }
  }

  for (const slot of slots) {
    clusterOrigins.set(slot.id, { x: slot.x, y: slot.y });
    // Tangent of the spiral ≈ angle + pitch; aligns mini-galaxies with the arm
    clusterArmAngle.set(slot.id, slot.angle + Math.atan(1 / wind) + Math.PI / 2);
  }

  // Soft dust lanes tracing the same curves the cluster slots follow
  // (sans per-cluster jitter/size boosts). Stored unflattened — the
  // renderer applies the disk flatten so it can rotate as a rigid body.
  const armGlowArms: Array<Array<{ x: number; y: number }>> = [];
  if (ordered.length > 0) {
    const steps = 24;
    for (let arm = 0; arm < armCount; arm++) {
      const armBase = (arm * Math.PI * 2) / armCount;
      const points: Array<{ x: number; y: number }> = [];
      for (let s = 0; s <= steps; s++) {
        const t = 0.04 + (s / steps) * (1.05 - 0.04);
        const angle = globalSpin + armBase + t * wind + t * t * 0.9;
        const radius = coreGap * 0.8 + t * (rimExtra + ordered.length * 34) + 40;
        points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
      }
      armGlowArms.push(points);
    }
  }

  const positions = new Map<
    string,
    { x: number; y: number; angle: number; radius: number }
  >();
  const figureIds = new Set<string>();

  for (const cluster of named) {
    const origin = clusterOrigins.get(cluster.id) || { x: 0, y: 480 };
    placeConstellationMembers(
      byCluster.get(cluster.id) || [],
      origin,
      cluster.id,
      positions,
      clusterShapes.get(cluster.id),
      clusterArmAngle.get(cluster.id),
      figureIds
    );
  }

  const clusterNodes: LayoutNode[] = [];
  const clusterColorById = new Map<string, string>();
  for (const cluster of named) {
    if (cluster.kind === "other") continue;
    if (cluster.count < 2) continue;
    const origin = clusterOrigins.get(cluster.id)!;
    const color = clusterBrandColor(cluster.name, cluster.kind);
    clusterColorById.set(cluster.id, color);
    const members = byCluster.get(cluster.id) || [];
    const starExtent = members.reduce((m, c) => {
      const p = positions.get(c.id);
      if (!p) return m;
      return Math.max(m, Math.hypot(p.x - origin.x, p.y - origin.y));
    }, 80);
    const nebulaRadius = Math.max(90, starExtent + 70);
    const labelDist = nebulaRadius * 0.55 + 12;
    const outward = Math.atan2(origin.y, origin.x);

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
      position: { x: origin.x, y: origin.y },
      draggable: false,
      selectable: true,
      zIndex: 0,
    });

    // Label on the outer edge of the cluster (away from sun)
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
        x: origin.x + Math.cos(outward) * labelDist,
        y: origin.y + Math.sin(outward) * labelDist,
      },
      draggable: false,
      selectable: true,
      zIndex: 7,
    });
  }

  const nodes: LayoutNode[] = [
    ...(armGlowArms.length > 0
      ? [
          {
            id: "arm-glow",
            type: "armGlow" as const,
            data: {
              kind: "armGlow" as const,
              arms: armGlowArms,
              flatten,
            },
            position: { x: 0, y: 0 },
            draggable: false,
            selectable: false,
            zIndex: -3,
          },
        ]
      : []),
    {
      id: "rings",
      type: "orbitRings",
      data: {
        kind: "rings",
        radii: [...RING_RADII],
        showLabels: false,
        flatten: GALAXY_FLATTEN,
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
      const pos = positions.get(c.id) || {
        x: (hashUnit(c.id, 9) - 0.5) * 200,
        y: 320 + hashUnit(c.id, 10) * 100,
        angle: 0,
        radius: 320,
      };
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
          figureRole: figureIds.has(c.id) ? ("figure" as const) : ("scatter" as const),
          clusterColor: cluster ? clusterColorById.get(cluster.id) : undefined,
          orbitAngle: pos.angle,
          orbitRadius: pos.radius,
        },
        position: { x: pos.x, y: pos.y },
        zIndex: dormant ? 6 : 5,
      };
    }),
  ];

  // Constellation path edges only — brand-tinted lines along each figure
  const edges: LayoutEdge[] = [];
  for (const peer of buildPeerEdges(contacts, { constellationOnly: true })) {
    const layoutEdge = peerEdgeToLayoutEdge(peer);
    const brand =
      peer.company && (peer.reason === "company" || peer.reason === "school")
        ? clusterBrandColor(peer.company, peer.reason)
        : undefined;
    edges.push({
      ...layoutEdge,
      type: "labeled",
      label: undefined,
      style: brand
        ? {
            ...layoutEdge.style,
            stroke: withAlpha(mixWithWhite(brand, 0.55), 0.8),
          }
        : layoutEdge.style,
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
