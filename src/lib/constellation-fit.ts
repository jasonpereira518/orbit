/**
 * Constellation fit: the shared model behind the star chart.
 *
 * One place decides which members trace each part's figure (a small cluster
 * is one part; a big company is a core plus petals; a school is a ring) and
 * which star each member sits on. Both the layout (star positions) and
 * peer-edge derivation (figure lines) consume this module, so lines and
 * stars cannot drift apart.
 */

import { isCometContact } from "@/lib/comet";
import {
  buildConstellationClusters,
  type BuiltCluster,
  type ClusterKind,
  type ClusterRef,
} from "@/lib/constellation-clusters";
import {
  assignClusterShapes,
  figureStarCount,
  type ConstellationShape,
} from "@/lib/constellation-shapes";
import {
  knotOrder,
  planClusterParts,
  type ClusterForm,
  type PartRole,
} from "@/lib/constellation-parts";
import { RING_CAPACITY } from "@/lib/graph/cluster-anatomy";
import type { GraphContactInput } from "@/lib/graph-layout";
import { schoolGroupKeys } from "@/lib/school-key";

export function clampScore(score: number | null | undefined) {
  return Math.min(5, Math.max(1, score || 2));
}

/** Ring used for placement — cohort orbit score, falling back to the manual rating. */
export function placementScore(c: GraphContactInput) {
  return clampScore(c.orbitScore ?? c.relationshipScore);
}

export function isDormantContact(c: GraphContactInput) {
  return c.dormant ?? isCometContact(c.lastInteractionAt);
}

function displayName(c: { fullName: string; preferredName?: string | null }) {
  const preferred = (c.preferredName || "").trim();
  return preferred || c.fullName;
}

/**
 * Stable order for constellation membership. Dormant contacts sort last so
 * figures are traced by active, closest people; in clusters above the figure
 * cap they demote to the scatter field.
 */
export function orderConstellationMembers(members: GraphContactInput[]) {
  return [...members].sort((a, b) => {
    const dormantDiff = (isDormantContact(a) ? 1 : 0) - (isDormantContact(b) ? 1 : 0);
    if (dormantDiff !== 0) return dormantDiff;
    const scoreDiff = placementScore(b) - placementScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    // Two people can share a name: id last, so the order never follows the input's.
    return displayName(a).localeCompare(displayName(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

/** A ring's stars are drawn with no figure lines: a school is a place, not a picture. */
export const RING_SHAPE: ConstellationShape = { id: "ring", name: "Ring", stars: [], edges: [] };

/** One figure in a cluster: the whole of a small cluster, or a core / petal of a big company. */
export type FitPart = {
  key: string;
  label: string | null;
  role: PartRole;
  shape: ConstellationShape;
  /** figureMemberIds[i] traces shape.stars[i], in placement order. */
  figureMemberIds: string[];
  /** Members beyond the figure cap; they scatter around this part. */
  scatterMemberIds: string[];
};

export type ClusterFit = {
  cluster: BuiltCluster;
  form: ClusterForm;
  parts: FitPart[];
  /**
   * Aggregates over `parts`, for callers that only need "who is a figure star and who is
   * scatter": `shape` is the first part's, the id lists are the parts' lists joined in part
   * order. Anything that pairs ids with shape stars must go through `parts`. `shape` has no
   * reader in src and is kept only so old tests keep pairing; new code must use `parts`.
   */
  shape: ConstellationShape;
  figureMemberIds: string[];
  scatterMemberIds: string[];
};

export type ConstellationFitResult = {
  clusters: BuiltCluster[];
  byContactId: Map<string, ClusterRef>;
  /** Keyed by cluster id; only wedge-eligible clusters (company/role/school, ≥2 members). */
  fits: Map<string, ClusterFit>;
};

/** Clusters that own a slice of sky; everything else is deep-space background. */
export function isWedgeEligible(cluster: { kind: ClusterKind; count: number }) {
  return cluster.kind !== "other" && cluster.count >= 2;
}

export function buildConstellationFit(
  contacts: GraphContactInput[]
): ConstellationFitResult {
  const { clusters, byContactId } = buildConstellationClusters(contacts);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));

  // Plan every cluster's parts first: how many shapes to ask for depends on it.
  const planned: Array<{
    cluster: BuiltCluster;
    members: GraphContactInput[];
    plan: ReturnType<typeof planClusterParts>;
  }> = [];
  for (const cluster of clusters) {
    if (!isWedgeEligible(cluster)) continue;
    const members = cluster.contactIds
      .map((id) => contactsById.get(id))
      .filter((c): c is GraphContactInput => Boolean(c));
    if (members.length < 2) continue;
    const ordered = orderConstellationMembers(members);
    planned.push({
      cluster,
      members: ordered,
      plan: planClusterParts(cluster, ordered),
    });
  }

  // Every cluster asks for a shape under its own id, exactly as before, so a cluster that is
  // not split keeps the figure it always had. The parts of a split company ask after everyone.
  // Rings and petal companies request a classic shape they never draw, on purpose: dropping the
  // request would hand that shape to a later cluster and move an existing constellation.
  const requests = clusters.map((c) => ({ id: c.id, contactIds: c.contactIds }));
  for (const { cluster, plan } of planned) {
    if (plan.form !== "petal") continue;
    for (const part of plan.parts) {
      requests.push({ id: `${cluster.id}#${part.key}`, contactIds: part.memberIds });
    }
  }
  const shapes = assignClusterShapes(requests);

  const fits = new Map<string, ClusterFit>();
  for (const { cluster, members, plan } of planned) {
    // Classmates get adjacent stars inside a petal: school keys, grouped by spelling.
    const schoolKey = new Map<string, string | null>();
    if (plan.form === "petal") {
      const groups = schoolGroupKeys(
        members.map((m) => (m.school ?? "").trim()).filter(Boolean)
      );
      for (const m of members) schoolKey.set(m.id, groups.get((m.school ?? "").trim()) ?? null);
    }

    const parts: FitPart[] = [];
    for (const p of plan.parts) {
      const shape =
        plan.form === "ring"
          ? RING_SHAPE
          : shapes.get(plan.form === "petal" ? `${cluster.id}#${p.key}` : cluster.id);
      // Unreachable: assignClusterShapes answers every request. Never skip a cluster silently.
      if (!shape) throw new Error(`constellation-fit: no shape for ${cluster.id}/${p.key}`);
      const figureCount =
        plan.form === "ring"
          ? Math.min(p.memberIds.length, RING_CAPACITY)
          : Math.min(shape.stars.length, figureStarCount(p.memberIds.length));
      let figureMemberIds = p.memberIds.slice(0, figureCount);
      if (p.role === "petal") {
        figureMemberIds = knotOrder(figureMemberIds, (id) => schoolKey.get(id) ?? null);
      }
      parts.push({
        key: p.key,
        label: p.label,
        role: p.role,
        shape,
        figureMemberIds,
        scatterMemberIds: p.memberIds.slice(figureCount),
      });
    }

    fits.set(cluster.id, {
      cluster,
      form: plan.form,
      parts,
      shape: parts[0].shape,
      figureMemberIds: parts.flatMap((p) => p.figureMemberIds),
      scatterMemberIds: parts.flatMap((p) => p.scatterMemberIds),
    });
  }

  return { clusters, byContactId, fits };
}

export type FitEdge = {
  source: string;
  target: string;
  clusterId: string;
  clusterName: string;
  clusterKind: ClusterKind;
  /** How the cluster is drawn, and which part of it the line belongs to. */
  form: ClusterForm;
  partRole: PartRole;
};

/** The figure lines: shape edges resolved to the members on their endpoints. */
export function constellationFitEdges(fit: ConstellationFitResult): FitEdge[] {
  const out: FitEdge[] = [];
  for (const { cluster, form, parts } of fit.fits.values()) {
    for (const { shape, figureMemberIds, role } of parts) {
      for (const [ai, bi] of shape.edges) {
        const a = figureMemberIds[ai];
        const b = figureMemberIds[bi];
        if (!a || !b || a === b) continue;
        out.push({
          source: a,
          target: b,
          clusterId: cluster.id,
          clusterName: cluster.name,
          clusterKind: cluster.kind,
          form,
          partRole: role,
        });
      }
    }
  }
  return out;
}
