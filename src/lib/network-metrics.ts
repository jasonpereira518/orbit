import { displayName, type EdgeKind, type GraphContactInput, type LayoutEdge } from "@/lib/graph-layout";
import { buildConstellationClusters } from "@/lib/constellation-clusters";
import { resolveConstellationShape } from "@/lib/constellation-shapes";
import { computeCloseness, type ClosenessContact } from "@/lib/closeness";

export type PeerEdgeReason =
  | "company"
  | "school"
  | "event"
  | "howMet"
  | "mention"
  | "sharedTags"
  | "sharedInterests";

export const PEER_REASON_LABELS: Record<PeerEdgeReason, string> = {
  company: "Same company",
  school: "Same school",
  event: "Same event",
  howMet: "Met together",
  mention: "Mentioned",
  sharedTags: "Shared tags",
  sharedInterests: "Shared interests",
};

export type PeerEdge = {
  source: string;
  target: string;
  kind: Extract<EdgeKind, "constellation" | "knows">;
  reason: PeerEdgeReason;
  company?: string;
};

export type NetworkMetrics = {
  tierCounts: { inner: number; mid: number; outer: number };
  totalContacts: number;
  totalPeerEdges: number;
  avgPeerDegree: number;
  degreeBuckets: { none: number; oneToTwo: number; threePlus: number };
};

export type ContactWithNetwork = ClosenessContact & {
  id: string;
  fullName: string;
  preferredName?: string | null;
  company?: string | null;
  title?: string | null;
  tags?: string[] | null;
  howMet?: string | null;
  notes?: string | null;
  aiSummary?: string | null;
  keyFacts?: string[] | null;
  sharedInterests?: string[] | null;
  closeness: number;
  tier: "inner" | "mid" | "outer";
  orbitScore: number;
  goalRelevance: number;
  peerDegree: number;
};

function pairKey(a: string, b: string) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function contactCorpus(c: GraphContactInput) {
  return [
    c.aiSummary || "",
    ...(c.keyFacts || []),
    c.notes || "",
    ...(c.sharedInterests || []),
  ]
    .join(" ")
    .toLowerCase();
}

function nameAliases(c: GraphContactInput) {
  const names = new Set<string>();
  const full = c.fullName.trim();
  const preferred = (c.preferredName || "").trim();
  if (full.length >= 3) names.add(full.toLowerCase());
  if (preferred.length >= 3) names.add(preferred.toLowerCase());
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (last.length >= 4) names.add(last.toLowerCase());
  }
  return [...names];
}

function mentionsOther(a: GraphContactInput, b: GraphContactInput) {
  const text = contactCorpus(a);
  if (!text) return false;
  return nameAliases(b).some((alias) => {
    if (alias.length < 3) return false;
    return text.includes(alias);
  });
}

function sharedCount(a: string[], b: string[]) {
  const setB = new Set(b.map((t) => t.toLowerCase()));
  let n = 0;
  for (const t of a) {
    if (setB.has(t.toLowerCase())) n += 1;
  }
  return n;
}

function addPeerEdge(
  edges: PeerEdge[],
  seen: Set<string>,
  source: string,
  target: string,
  edge: Omit<PeerEdge, "source" | "target">
) {
  if (source === target) return;
  const key = pairKey(source, target);
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({ source, target, ...edge });
}

/**
 * Derive peer edges between contacts.
 * Constellation edges are a single winding path (like a star figure) —
 * not a closed polygon or mesh of diagonals.
 */
export function buildPeerEdges(
  contacts: GraphContactInput[],
  options?: {
    positions?: Map<string, { angle: number }>;
    constellationOnly?: boolean;
  }
): PeerEdge[] {
  const edges: PeerEdge[] = [];
  const seenPairs = new Set<string>();

  const { clusters, byContactId } = buildConstellationClusters(contacts);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));

  for (const cluster of clusters) {
    if (cluster.count < 2 || cluster.kind === "other") continue;
    const group = cluster.contactIds
      .map((id) => contactsById.get(id))
      .filter(Boolean) as GraphContactInput[];
    if (group.length < 2) continue;

    const ordered = [...group].sort((a, b) => {
      const scoreA = a.orbitScore ?? a.relationshipScore ?? 2;
      const scoreB = b.orbitScore ?? b.relationshipScore ?? 2;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return displayName(a).localeCompare(displayName(b));
    });

    const reason: PeerEdgeReason =
      cluster.kind === "company"
        ? "company"
        : cluster.kind === "school"
          ? "school"
          : "howMet";

    // Edges follow the real constellation figure for this star count
    const shape = resolveConstellationShape(ordered.length, cluster.id);
    for (const [ai, bi] of shape.edges) {
      const a = ordered[ai];
      const b = ordered[bi];
      if (!a || !b) continue;
      addPeerEdge(edges, seenPairs, a.id, b.id, {
        kind: "constellation",
        reason,
        company: cluster.name,
      });
    }
  }

  if (options?.constellationOnly) {
    return edges;
  }

  // Soft knows links across clusters (metrics / other surfaces)
  for (let i = 0; i < contacts.length; i++) {
    for (let j = i + 1; j < contacts.length; j++) {
      const a = contacts[i];
      const b = contacts[j];
      const ca = byContactId.get(a.id)?.id;
      const cb = byContactId.get(b.id)?.id;
      if (ca && cb && ca === cb) continue;

      if (mentionsOther(a, b) || mentionsOther(b, a)) {
        addPeerEdge(edges, seenPairs, a.id, b.id, {
          kind: "knows",
          reason: "mention",
        });
        continue;
      }

      const tagOverlap = sharedCount(a.tags || [], b.tags || []);
      if (tagOverlap >= 2) {
        addPeerEdge(edges, seenPairs, a.id, b.id, {
          kind: "knows",
          reason: "sharedTags",
        });
        continue;
      }

      const interestOverlap = sharedCount(
        a.sharedInterests || [],
        b.sharedInterests || []
      );
      if (interestOverlap >= 2) {
        addPeerEdge(edges, seenPairs, a.id, b.id, {
          kind: "knows",
          reason: "sharedInterests",
        });
      }
    }
  }

  return edges;
}

/** Style presets for peer edges when rendering in the graph. */
export function peerEdgeToLayoutEdge(edge: PeerEdge): LayoutEdge {
  const key = pairKey(edge.source, edge.target);
  const isConstellation = edge.kind === "constellation";
  return {
    id: `${edge.kind}-${key}`,
    source: edge.source,
    target: edge.target,
    type: "straight",
    animated: false,
    label: PEER_REASON_LABELS[edge.reason],
    data: {
      kind: edge.kind,
      company: edge.company,
      reason: edge.reason,
      label: PEER_REASON_LABELS[edge.reason],
    },
    style: {
      stroke: isConstellation
        ? "rgba(255, 255, 255, 0.75)"
        : "rgba(255, 255, 255, 0.35)",
      strokeWidth: isConstellation ? 1.1 : 0.8,
      opacity: isConstellation ? 0.85 : 0.4,
    },
  };
}

function peerDegreeMap(edges: PeerEdge[], knowsOnly: boolean) {
  const degrees = new Map<string, number>();
  for (const e of edges) {
    if (knowsOnly && e.kind !== "knows") continue;
    degrees.set(e.source, (degrees.get(e.source) || 0) + 1);
    degrees.set(e.target, (degrees.get(e.target) || 0) + 1);
  }
  return degrees;
}

export function computeNetworkMetrics(
  contacts: Array<
    ClosenessContact & {
      id: string;
      fullName: string;
      preferredName?: string | null;
      company?: string | null;
      title?: string | null;
      tags?: string[] | null;
      howMet?: string | null;
      notes?: string | null;
      aiSummary?: string | null;
      keyFacts?: string[] | null;
      sharedInterests?: string[] | null;
    }
  >,
  activeGoals: string[] = []
): { metrics: NetworkMetrics; contactsWithNetwork: ContactWithNetwork[] } {
  const graphContacts: GraphContactInput[] = contacts.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    preferredName: c.preferredName,
    company: c.company ?? null,
    title: c.title ?? null,
    relationshipScore: c.relationshipScore ?? 2,
    lastInteractionAt: c.lastInteractionAt ?? null,
    nextFollowUpAt: null,
    tags: c.tags ?? [],
    aiSummary: c.aiSummary ?? null,
    keyFacts: c.keyFacts ?? null,
    howMet: c.howMet ?? null,
    notes: c.notes ?? null,
    sharedInterests: c.sharedInterests ?? null,
  }));

  const peerEdges = buildPeerEdges(graphContacts);
  const knowsDegrees = peerDegreeMap(peerEdges, true);

  const tierCounts = { inner: 0, mid: 0, outer: 0 };
  const degreeBuckets = { none: 0, oneToTwo: 0, threePlus: 0 };
  const contactsWithNetwork: ContactWithNetwork[] = [];

  for (const c of contacts) {
    const breakdown = computeCloseness(c, activeGoals);
    tierCounts[breakdown.tier] += 1;
    const peerDegree = knowsDegrees.get(c.id) || 0;
    if (peerDegree === 0) degreeBuckets.none += 1;
    else if (peerDegree <= 2) degreeBuckets.oneToTwo += 1;
    else degreeBuckets.threePlus += 1;

    contactsWithNetwork.push({
      ...c,
      closeness: breakdown.closeness,
      tier: breakdown.tier,
      orbitScore: breakdown.orbitScore,
      goalRelevance: breakdown.goalRelevance,
      peerDegree,
    });
  }

  const knowsEdges = peerEdges.filter((e) => e.kind === "knows");
  const totalPeerDegree = [...knowsDegrees.values()].reduce((a, b) => a + b, 0);
  const avgPeerDegree =
    contacts.length > 0 ? totalPeerDegree / contacts.length : 0;

  return {
    metrics: {
      tierCounts,
      totalContacts: contacts.length,
      totalPeerEdges: knowsEdges.length,
      avgPeerDegree: Math.round(avgPeerDegree * 10) / 10,
      degreeBuckets,
    },
    contactsWithNetwork,
  };
}
