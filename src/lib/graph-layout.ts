import { isCometContact } from "@/lib/comet";
import {
  buildConstellationClusters,
  type ClusterKind,
} from "@/lib/constellation-clusters";
import {
  resolveConstellationShape,
  scaleForStarCount,
} from "@/lib/constellation-shapes";
import { buildPeerEdges, peerEdgeToLayoutEdge } from "@/lib/network-metrics";
import { clusterBrandColor } from "@/lib/school-color";

/** Decorative orbit rings (visual grid only — no spokes). */
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
  orbitAngle?: number;
  orbitRadius?: number;
  spotlight?: boolean;
  labelMode?: "always" | "hover" | "never";
  motionEnabled?: boolean;
  motionPaused?: boolean;
};

export type OrbitRingsData = {
  kind: "rings";
  radii: number[];
  showLabels?: boolean;
  motionEnabled?: boolean;
};

export type ClusterLabelData = {
  kind: "clusterLabel";
  label: string;
  count?: number;
  nebulaColor?: string;
  clusterKind?: ClusterKind;
};

export type NebulaData = {
  kind: "nebula";
  company: string;
  color: string;
  radius: number;
  clusterKind?: ClusterKind;
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

export type GroupingMode = "score" | "company";

function clampScore(score: number | null | undefined) {
  return Math.min(5, Math.max(1, score || 2));
}

function placementScore(c: GraphContactInput) {
  return clampScore(c.orbitScore ?? c.relationshipScore);
}

/** Stable order for constellation star placement and path edges. */
export function orderConstellationMembers(members: GraphContactInput[]) {
  return [...members].sort((a, b) => {
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
 * Map cluster members onto a real constellation figure (Cassiopeia, Draco, …).
 */
function placeConstellationMembers(
  members: GraphContactInput[],
  origin: { x: number; y: number },
  clusterSeed: string,
  positions: Map<string, { x: number; y: number; angle: number; radius: number }>
) {
  const sorted = orderConstellationMembers(members);
  const n = sorted.length;
  if (n === 0) return;

  const shape = resolveConstellationShape(n, clusterSeed);
  const scale = scaleForStarCount(n);
  const rotation = (hashUnit(clusterSeed, 11) - 0.5) * Math.PI * 0.7;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  sorted.forEach((c, i) => {
    const star = shape.stars[i] || { x: 0, y: 0 };
    let lx = (star.x * cos - star.y * sin) * scale;
    let ly = (star.x * sin + star.y * cos) * scale;

    const dormant = c.dormant === true || isCometContact(c.lastInteractionAt);
    if (dormant) {
      const away = Math.atan2(origin.y, origin.x) || rotation;
      lx += Math.cos(away) * 40;
      ly += Math.sin(away) * 40;
    }

    const x = origin.x + lx;
    const y = origin.y + ly;
    positions.set(c.id, {
      x,
      y,
      angle: Math.atan2(y, x),
      radius: Math.hypot(x, y),
    });
  });
}

/**
 * Constellation map:
 * - Sun at center (identity only — no spokes)
 * - Faint orbit rings as spatial grid
 * - Clusters by Company → School arranged radially
 * - Peer constellation links within clusters
 */
export function buildHybridGraphLayout(
  contacts: GraphContactInput[],
  userName: string,
  _options?: { grouping?: GroupingMode }
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
  const named = clusters.filter((c) => c.kind !== "other" || c.count >= 1);
  const namedCount = Math.max(named.length, 1);
  let angleCursor = -Math.PI / 2;

  for (let i = 0; i < named.length; i++) {
    const cluster = named[i];
    const members = byCluster.get(cluster.id) || [];
    const size = members.length;
    const avgScore =
      members.reduce((s, c) => s + placementScore(c), 0) / Math.max(size, 1);
    const closenessBoost = (avgScore - 3) * 22;

    // Push constellations farther out and apart so figures don’t overlap
    const band =
      cluster.kind === "company" ? 0 : cluster.kind === "school" ? 1 : 2;
    const radius =
      320 +
      band * 90 +
      Math.min(size, 14) * 28 +
      (i % 4) * 55 -
      closenessBoost +
      hashUnit(cluster.id, 8) * 60;

    const share = Math.max(0.12, size / Math.max(contacts.length, 1));
    const span = Math.max(
      0.32,
      (Math.PI * 2 * share) / Math.max(namedCount * 0.22, 1)
    );
    const mid = angleCursor + span / 2;
    angleCursor += span + 0.14;

    clusterOrigins.set(cluster.id, {
      x: Math.cos(mid) * Math.max(280, radius),
      y: Math.sin(mid) * Math.max(280, radius),
    });
  }

  const positions = new Map<
    string,
    { x: number; y: number; angle: number; radius: number }
  >();

  for (const cluster of named) {
    const origin = clusterOrigins.get(cluster.id) || { x: 0, y: 380 };
    placeConstellationMembers(
      byCluster.get(cluster.id) || [],
      origin,
      cluster.id,
      positions
    );
  }

  const clusterNodes: LayoutNode[] = [];
  for (const cluster of named) {
    if (cluster.kind === "other") continue;
    if (cluster.count < 2) continue;
    const origin = clusterOrigins.get(cluster.id)!;
    const color = clusterBrandColor(cluster.name, cluster.kind);
    const nebulaRadius = 60 + Math.min(cluster.count, 14) * 13;

    clusterNodes.push({
      id: `nebula-${cluster.id}`,
      type: "nebula",
      data: {
        kind: "nebula",
        company: cluster.name,
        color,
        radius: nebulaRadius,
        clusterKind: cluster.kind,
      },
      position: { x: origin.x, y: origin.y },
      draggable: false,
      selectable: false,
      zIndex: 0,
    });

    // Label on the outer edge of the cluster (away from sun)
    const labelDist = nebulaRadius * 0.7 + 8;
    const outward = Math.atan2(origin.y, origin.x);
    clusterNodes.push({
      id: `cluster-${cluster.id}`,
      type: "clusterLabel",
      data: {
        kind: "clusterLabel",
        label: cluster.name,
        count: cluster.count,
        nebulaColor: color,
        clusterKind: cluster.kind,
      },
      position: {
        x: origin.x + Math.cos(outward) * labelDist,
        y: origin.y + Math.sin(outward) * labelDist,
      },
      draggable: false,
      selectable: false,
      zIndex: 1,
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
        motionEnabled: false,
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
          orbitAngle: pos.angle,
          orbitRadius: pos.radius,
        },
        position: { x: pos.x, y: pos.y },
        zIndex: dormant ? 6 : 5,
      };
    }),
  ];

  // Constellation path edges only — white lines along each figure
  const edges: LayoutEdge[] = [];
  for (const peer of buildPeerEdges(contacts, { constellationOnly: true })) {
    const layoutEdge = peerEdgeToLayoutEdge(peer);
    edges.push({
      ...layoutEdge,
      type: "labeled",
      label: undefined,
      data: {
        kind: layoutEdge.data!.kind,
        company: layoutEdge.data?.company,
        reason: layoutEdge.data?.reason,
      },
    });
  }

  return { nodes, edges };
}
