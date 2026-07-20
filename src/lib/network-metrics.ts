import { computeCloseness, type ClosenessContact } from "@/lib/closeness";
import {
  displayName,
  type EdgeKind,
  type GraphContactInput,
  type LayoutEdge,
} from "@/lib/graph-layout";

export type PeerEdgeReason =
  | "company"
  | "howMet"
  | "mention"
  | "sharedTags"
  | "sharedInterests";

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

function companyKey(company: string | null | undefined) {
  const trimmed = (company || "").trim();
  return trimmed || "__none__";
}

function normalizePhrase(value: string | null | undefined) {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

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

function orderGroup(
  group: GraphContactInput[],
  positions?: Map<string, { angle: number }>
) {
  if (positions) {
    return [...group].sort((a, b) => {
      const aa = positions.get(a.id)?.angle ?? 0;
      const bb = positions.get(b.id)?.angle ?? 0;
      return aa - bb;
    });
  }
  return [...group].sort((a, b) =>
    displayName(a).localeCompare(displayName(b))
  );
}

/**
 * Derive peer edges between contacts (company constellations + knows links).
 * Reused by graph layout and dashboard network metrics.
 */
export function buildPeerEdges(
  contacts: GraphContactInput[],
  options?: { positions?: Map<string, { angle: number }> }
): PeerEdge[] {
  const edges: PeerEdge[] = [];
  const seenPairs = new Set<string>();
  const positions = options?.positions;

  const byCompany = new Map<string, GraphContactInput[]>();
  for (const c of contacts) {
    const key = companyKey(c.company);
    if (key === "__none__") continue;
    const list = byCompany.get(key) || [];
    list.push(c);
    byCompany.set(key, list);
  }

  for (const [key, group] of byCompany) {
    if (group.length < 2) continue;
    const ordered = orderGroup(group, positions);

    for (let i = 0; i < ordered.length - 1; i++) {
      addPeerEdge(edges, seenPairs, ordered[i].id, ordered[i + 1].id, {
        kind: "constellation",
        reason: "company",
        company: key,
      });
    }

    if (ordered.length >= 3 && ordered.length <= 8) {
      addPeerEdge(
        edges,
        seenPairs,
        ordered[ordered.length - 1].id,
        ordered[0].id,
        { kind: "constellation", reason: "company", company: key }
      );
    }
  }

  const byHowMet = new Map<string, GraphContactInput[]>();
  for (const c of contacts) {
    const key = normalizePhrase(c.howMet);
    if (!key || key.length < 3) continue;
    const list = byHowMet.get(key) || [];
    list.push(c);
    byHowMet.set(key, list);
  }
  for (const group of byHowMet.values()) {
    if (group.length < 2) continue;
    const ordered = orderGroup(group, positions);
    for (let i = 0; i < ordered.length - 1; i++) {
      addPeerEdge(edges, seenPairs, ordered[i].id, ordered[i + 1].id, {
        kind: "knows",
        reason: "howMet",
      });
    }
  }

  for (let i = 0; i < contacts.length; i++) {
    for (let j = i + 1; j < contacts.length; j++) {
      const a = contacts[i];
      const b = contacts[j];
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
  const styles: Record<
    PeerEdgeReason,
    { stroke: string; strokeWidth: number; opacity: number }
  > = {
    company: {
      stroke: "rgba(255, 255, 255, 0.85)",
      strokeWidth: 1.05,
      opacity: 0.7,
    },
    howMet: {
      stroke: "rgba(255, 236, 200, 0.9)",
      strokeWidth: 0.95,
      opacity: 0.65,
    },
    mention: {
      stroke: "rgba(255, 255, 255, 0.8)",
      strokeWidth: 0.9,
      opacity: 0.6,
    },
    sharedTags: {
      stroke: "rgba(220, 230, 255, 0.75)",
      strokeWidth: 0.85,
      opacity: 0.4,
    },
    sharedInterests: {
      stroke: "rgba(220, 230, 255, 0.7)",
      strokeWidth: 0.8,
      opacity: 0.35,
    },
  };
  const style = styles[edge.reason];
  return {
    id: `${edge.kind}-${key}`,
    source: edge.source,
    target: edge.target,
    type: "straight",
    animated: false,
    data: {
      kind: edge.kind,
      company: edge.company,
      reason: edge.reason,
    },
    style,
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
