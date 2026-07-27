import { isCometContact } from "@/lib/comet";
import {
  buildConstellationClusters,
  type ClusterKind,
} from "@/lib/constellation-clusters";
import { companyFamilyKey } from "@/lib/company-family";
import {
  resolveConstellationShape,
  scaleForStarCount,
  constellationFootprint,
  assignClusterShapes,
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
 * Map cluster members onto a real constellation figure (Cassiopeia, Orion, …).
 * Keep rotation mild so classic stick-figures stay recognizable.
 */
function placeConstellationMembers(
  members: GraphContactInput[],
  origin: { x: number; y: number },
  clusterSeed: string,
  positions: Map<string, { x: number; y: number; angle: number; radius: number }>,
  shape = resolveConstellationShape(members.length, clusterSeed)
) {
  const sorted = orderConstellationMembers(members);
  const n = sorted.length;
  if (n === 0) return;

  const scale = scaleForStarCount(n);
  // ±~22° so Cassiopeia's W / Orion's belt stay readable
  const rotation = (hashUnit(clusterSeed, 11) - 0.5) * Math.PI * 0.25;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  sorted.forEach((c, i) => {
    const star = shape.stars[i] || { x: 0, y: 0 };
    let lx = (star.x * cos - star.y * sin) * scale;
    let ly = (star.x * sin + star.y * cos) * scale;

    const dormant = c.dormant === true || isCometContact(c.lastInteractionAt);
    if (dormant) {
      const away = Math.atan2(origin.y, origin.x) || rotation;
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
  });
}

/**
 * Constellation map:
 * - Sun at center (identity only — no spokes)
 * - Faint orbit rings as spatial grid
 * - Clusters by Company → School arranged along spiral galaxy arms
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

  // Seat related companies together (Google ↔ Google DeepMind, Amazon ↔ AWS)
  // by grouping on family before assigning spiral arms.
  const familyOf = (c: (typeof named)[number]) =>
    c.kind === "company"
      ? companyFamilyKey(c.name) || c.id
      : `kind:${c.kind}:${c.id}`;

  const familyTotals = new Map<string, number>();
  for (const c of named) {
    const f = familyOf(c);
    familyTotals.set(f, (familyTotals.get(f) || 0) + c.count);
  }

  const orderedNamed = [...named].sort((a, b) => {
    const fa = familyOf(a);
    const fb = familyOf(b);
    const ta = familyTotals.get(fa) || 0;
    const tb = familyTotals.get(fb) || 0;
    if (tb !== ta) return tb - ta;
    if (fa !== fb) return fa.localeCompare(fb);
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });

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
  };

  const armCount = Math.min(4, Math.max(2, Math.ceil(orderedNamed.length / 4)));
  const armTurn = 0.78;
  const armSpacing = 430;

  // Walk families in order: keep each family on one arm when possible,
  // packing members as consecutive steps so they sit near each other.
  const slots: Slot[] = [];
  const armLoad = Array.from({ length: armCount }, () => 0);
  let familyArmCursor = 0;

  let i = 0;
  while (i < orderedNamed.length) {
    const family = familyOf(orderedNamed[i]);
    const group: typeof orderedNamed = [];
    while (i < orderedNamed.length && familyOf(orderedNamed[i]) === family) {
      group.push(orderedNamed[i]);
      i += 1;
    }

    // Prefer the lightest arm so families spread around the galaxy
    let arm = 0;
    for (let a = 1; a < armCount; a++) {
      if (armLoad[a] < armLoad[arm]) arm = a;
    }
    // Slight rotation of preference so we don't always fill arm 0 first
    if (group.length === 1) {
      arm = familyArmCursor % armCount;
      familyArmCursor += 1;
      for (let a = 0; a < armCount; a++) {
        const cand = (arm + a) % armCount;
        if (armLoad[cand] <= armLoad[arm]) arm = cand;
      }
    }

    // Fractional steps pack related companies closer than unrelated neighbors
    const familyStepGap = group.length > 1 ? 0.55 : 1;
    let step = armLoad[arm];
    for (const cluster of group) {
      const members = byCluster.get(cluster.id) || [];
      const size = members.length;
      const avgScore =
        members.reduce((s, c) => s + placementScore(c), 0) / Math.max(size, 1);
      const band =
        cluster.kind === "company" ? 0 : cluster.kind === "school" ? 1 : 2;
      const foot = constellationFootprint(size);

      const radius =
        500 +
        step * armSpacing +
        band * 90 +
        Math.min(size, 14) * 20 -
        (avgScore - 3) * 12 +
        hashUnit(cluster.id, 8) * 70;
      const angle =
        -Math.PI / 2 +
        (arm * Math.PI * 2) / armCount +
        step * armTurn +
        (hashUnit(cluster.id, 12) - 0.5) * (group.length > 1 ? 0.04 : 0.12);

      slots.push({
        id: cluster.id,
        foot,
        arm,
        step: Math.floor(step),
        angle,
        radius: Math.max(480, radius),
      });
      step += familyStepGap;
    }
    armLoad[arm] = Math.ceil(step);
  }

  // Resolve any collisions while preserving each cluster's spiral arm.
  // Moving the outer/later cluster down its arm keeps the galaxy silhouette.
  for (let iter = 0; iter < 5; iter++) {
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i];
        const b = slots[j];
        const ax = Math.cos(a.angle) * a.radius;
        const ay = Math.sin(a.angle) * a.radius;
        const bx = Math.cos(b.angle) * b.radius;
        const by = Math.sin(b.angle) * b.radius;
        const dist = Math.hypot(ax - bx, ay - by);
        const minDist = a.foot * 0.72 + b.foot * 0.72 + 150;
        if (dist < minDist) {
          const move = b.step >= a.step ? b : a;
          const push = minDist - dist + 36;
          move.radius += push;
          move.angle += (move.arm % 2 === 0 ? 1 : -1) * push * 0.0007;
        }
      }
    }
  }

  for (const slot of slots) {
    clusterOrigins.set(slot.id, {
      x: Math.cos(slot.angle) * slot.radius,
      y: Math.sin(slot.angle) * slot.radius,
    });
  }

  const positions = new Map<
    string,
    { x: number; y: number; angle: number; radius: number }
  >();

  for (const cluster of named) {
    const origin = clusterOrigins.get(cluster.id) || { x: 0, y: 480 };
    placeConstellationMembers(
      byCluster.get(cluster.id) || [],
      origin,
      cluster.id,
      positions,
      clusterShapes.get(cluster.id)
    );
  }

  const clusterNodes: LayoutNode[] = [];
  for (const cluster of named) {
    if (cluster.kind === "other") continue;
    if (cluster.count < 2) continue;
    const origin = clusterOrigins.get(cluster.id)!;
    const color = clusterBrandColor(cluster.name, cluster.kind);
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
      },
      position: { x: origin.x, y: origin.y },
      draggable: false,
      selectable: false,
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
      data: layoutEdge.data
        ? {
            kind: layoutEdge.data.kind,
            company: layoutEdge.data.company,
            reason: layoutEdge.data.reason,
          }
        : undefined,
    });
  }

  return { nodes, edges };
}
