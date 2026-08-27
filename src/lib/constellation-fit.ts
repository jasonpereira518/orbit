/**
 * Constellation fit: the shared model behind the star chart.
 *
 * One place decides which members trace a cluster's asterism figure and
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
import type { GraphContactInput } from "@/lib/graph-layout";

export function clampScore(score: number | null | undefined) {
  return Math.min(5, Math.max(1, score || 2));
}

/** Ring used for placement — cohort orbit score, falling back to the manual rating. */
export function placementScore(c: GraphContactInput) {
  return clampScore(c.orbitScore ?? c.relationshipScore);
}

export function isDormantContact(c: GraphContactInput) {
  return c.dormant === true || isCometContact(c.lastInteractionAt);
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
    return displayName(a).localeCompare(displayName(b));
  });
}

export type ClusterFit = {
  cluster: BuiltCluster;
  shape: ConstellationShape;
  /**
   * figureMemberIds[i] traces shape.stars[i], in placement order — the top
   * members by orderConstellationMembers trace the figure.
   */
  figureMemberIds: string[];
  /** Members beyond the figure cap; they scatter around the figure. */
  scatterMemberIds: string[];
};

export type ConstellationFitResult = {
  clusters: BuiltCluster[];
  byContactId: Map<string, ClusterRef>;
  /** Keyed by cluster id; only wedge-eligible clusters (company/school, ≥2 members). */
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
  const shapes = assignClusterShapes(
    clusters.map((c) => ({ id: c.id, contactIds: c.contactIds }))
  );

  const fits = new Map<string, ClusterFit>();
  for (const cluster of clusters) {
    if (!isWedgeEligible(cluster)) continue;
    const members = cluster.contactIds
      .map((id) => contactsById.get(id))
      .filter((c): c is GraphContactInput => Boolean(c));
    if (members.length < 2) continue;

    const shape = shapes.get(cluster.id);
    if (!shape) continue;

    const ordered = orderConstellationMembers(members);
    const figureCount = Math.min(
      shape.stars.length,
      figureStarCount(ordered.length)
    );
    const figureMemberIds = ordered.slice(0, figureCount).map((c) => c.id);
    const scatterMemberIds = ordered.slice(figureCount).map((c) => c.id);

    fits.set(cluster.id, { cluster, shape, figureMemberIds, scatterMemberIds });
  }

  return { clusters, byContactId, fits };
}

export type FitEdge = {
  source: string;
  target: string;
  clusterId: string;
  clusterName: string;
  clusterKind: ClusterKind;
};

/** The figure lines: shape edges resolved to the members on their endpoints. */
export function constellationFitEdges(fit: ConstellationFitResult): FitEdge[] {
  const out: FitEdge[] = [];
  for (const { cluster, shape, figureMemberIds } of fit.fits.values()) {
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
      });
    }
  }
  return out;
}
