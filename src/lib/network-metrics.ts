import type { EdgeKind, GraphContactInput, LayoutEdge } from "@/lib/graph-layout";
import {
  buildConstellationFit,
  constellationFitEdges,
} from "@/lib/constellation-fit";
import {
  closenessTier,
  computeClosenessForAll,
  type ClosenessBreakdown,
  type ClosenessContact,
} from "@/lib/closeness";

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
  /**
   * How many contacts the peer-link figures were actually computed over.
   *
   * Equal to `totalContacts` for most networks. Above `METRICS_MAX_CONTACTS` the link
   * analysis runs on the closest contacts only — see the note there — and the peer-link
   * stats describe that subset while `tierCounts` and `totalContacts` still describe
   * everyone. Surfaced rather than hidden so a caller can say so.
   */
  metricsSampleSize: number;
};

/**
 * Ceiling on how many contacts the peer-link analysis considers.
 *
 * `buildPeerEdges({ metrics: true })` compares every pair of contacts, so its cost grows
 * with the square of the network: 2,000 contacts is two million comparisons, 5,000 is
 * twelve and a half million — and this runs on the dashboard's render path, on every load.
 *
 * The cap is applied by closeness, so what survives is the part of the network the reader
 * cares about. "How interconnected are the people I actually know" is the question the
 * chart answers; the thousand acquaintances imported from a CSV and never touched since
 * were only ever adding cost to it.
 */
export const METRICS_MAX_CONTACTS = 750;

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

/**
 * Everything the all-pairs loop below needs from a single contact, derived once.
 *
 * The loop is O(n^2) by nature — it is asking which pairs are connected — but it used to
 * rebuild each contact's corpus string, alias list and lowercased tag sets *inside* the
 * pair comparison, so every contact's multi-KB notes were re-joined and re-lowercased
 * ~2n times instead of once. That made the constant factor scale with note length.
 */
type SoftKnowsFacts = {
  corpus: string;
  aliases: string[];
  tagsLower: string[];
  tagsSet: Set<string>;
  interestsLower: string[];
  interestsSet: Set<string>;
  clusterId: string | undefined;
};

function mentionsAliasOf(textOwner: SoftKnowsFacts, named: SoftKnowsFacts) {
  if (!textOwner.corpus) return false;
  return named.aliases.some((alias) => textOwner.corpus.includes(alias));
}

/**
 * Counts entries of `aLower` present in `bSet`. Deliberately iterates the array rather
 * than intersecting two sets: the original counted duplicates on the `a` side, and
 * collapsing them would quietly change the >= 2 thresholds this feeds.
 */
function overlapCount(aLower: string[], bSet: Set<string>) {
  let n = 0;
  for (const value of aLower) {
    if (bSet.has(value)) n += 1;
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

function clusterReason(kind: string): PeerEdgeReason {
  if (kind === "company") return "company";
  if (kind === "school") return "school";
  return "howMet";
}

function addSoftKnowsEdges(
  edges: PeerEdge[],
  seenPairs: Set<string>,
  contacts: GraphContactInput[],
  byContactId: Map<string, { id: string }>
) {
  const facts: SoftKnowsFacts[] = contacts.map((c) => {
    const tagsLower = (c.tags || []).map((t) => t.toLowerCase());
    const interestsLower = (c.sharedInterests || []).map((t) =>
      t.toLowerCase()
    );
    return {
      corpus: contactCorpus(c),
      // `nameAliases` already drops anything shorter than 3, which is the bar the pair
      // comparison used to re-apply per alias per pair.
      aliases: nameAliases(c).filter((alias) => alias.length >= 3),
      tagsLower,
      tagsSet: new Set(tagsLower),
      interestsLower,
      interestsSet: new Set(interestsLower),
      clusterId: byContactId.get(c.id)?.id,
    };
  });

  for (let i = 0; i < contacts.length; i++) {
    const a = contacts[i];
    const fa = facts[i];
    for (let j = i + 1; j < contacts.length; j++) {
      const b = contacts[j];
      const fb = facts[j];
      if (fa.clusterId && fb.clusterId && fa.clusterId === fb.clusterId)
        continue;

      if (mentionsAliasOf(fa, fb) || mentionsAliasOf(fb, fa)) {
        addPeerEdge(edges, seenPairs, a.id, b.id, {
          kind: "knows",
          reason: "mention",
        });
        continue;
      }

      if (overlapCount(fa.tagsLower, fb.tagsSet) >= 2) {
        addPeerEdge(edges, seenPairs, a.id, b.id, {
          kind: "knows",
          reason: "sharedTags",
        });
        continue;
      }

      if (overlapCount(fa.interestsLower, fb.interestsSet) >= 2) {
        addPeerEdge(edges, seenPairs, a.id, b.id, {
          kind: "knows",
          reason: "sharedInterests",
        });
      }
    }
  }
}

/**
 * Derive peer edges between contacts.
 * Constellation edges are a single winding path (like a star figure) —
 * not a closed polygon or mesh of diagonals.
 *
 * Pass `{ metrics: true }` for dashboard counts: all-pairs within
 * company/school clusters plus soft knows (not sparse star paths).
 */
/**
 * Peer edges between contacts. Constellation figure lines come straight from
 * buildConstellationFit — the same member↔star assignment that places stars
 * in graph-layout — so lines and stars cannot drift apart.
 */
export function buildPeerEdges(
  contacts: GraphContactInput[],
  options?: {
    constellationOnly?: boolean;
    /** All-pairs company/school + soft knows for Network depth metrics. */
    metrics?: boolean;
  }
): PeerEdge[] {
  const edges: PeerEdge[] = [];
  const seenPairs = new Set<string>();

  const fit = buildConstellationFit(contacts);
  const { clusters, byContactId } = fit;

  if (options?.metrics) {
    for (const cluster of clusters) {
      if (cluster.count < 2 || cluster.kind === "other") continue;
      const reason = clusterReason(cluster.kind);
      // Skip howMet clusters for metrics (company/school only).
      if (reason !== "company" && reason !== "school") continue;

      const ids = cluster.contactIds;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          addPeerEdge(edges, seenPairs, ids[i], ids[j], {
            kind: "constellation",
            reason,
            company: cluster.name,
          });
        }
      }
    }

    addSoftKnowsEdges(edges, seenPairs, contacts, byContactId);
    return edges;
  }

  for (const fitEdge of constellationFitEdges(fit)) {
    addPeerEdge(edges, seenPairs, fitEdge.source, fitEdge.target, {
      kind: "constellation",
      reason: clusterReason(fitEdge.clusterKind),
      company: fitEdge.clusterName,
    });
  }

  if (options?.constellationOnly) {
    return edges;
  }

  addSoftKnowsEdges(edges, seenPairs, contacts, byContactId);
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

function peerDegreeMap(edges: PeerEdge[]) {
  const degrees = new Map<string, number>();
  for (const e of edges) {
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
      school?: string | null;
      title?: string | null;
      tags?: string[] | null;
      howMet?: string | null;
      notes?: string | null;
      aiSummary?: string | null;
      keyFacts?: string[] | null;
      sharedInterests?: string[] | null;
    }
  >,
  activeGoals: string[] = [],
  /**
   * Pre-scored contacts from the shared request cohort. Omit and the cohort is
   * built from `contacts` alone — fine for a full list, wrong for a subset.
   */
  closenessById?: Map<string, ClosenessBreakdown>
): { metrics: NetworkMetrics; contactsWithNetwork: ContactWithNetwork[] } {
  const scores =
    closenessById ?? computeClosenessForAll(contacts, activeGoals);
  const graphContacts: GraphContactInput[] = contacts.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    preferredName: c.preferredName,
    company: c.company ?? null,
    school: c.school ?? null,
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

  // Only the closest `METRICS_MAX_CONTACTS` take part in the all-pairs link analysis.
  // Sorting by the already-computed score is O(n log n); comparing every pair is O(n²).
  const sampled =
    graphContacts.length <= METRICS_MAX_CONTACTS
      ? graphContacts
      : [...graphContacts]
          .sort(
            (a, b) =>
              (scores.get(b.id)?.closeness ?? 0) - (scores.get(a.id)?.closeness ?? 0)
          )
          .slice(0, METRICS_MAX_CONTACTS);
  const sampledIds = new Set(sampled.map((c) => c.id));

  const peerEdges = buildPeerEdges(sampled, { metrics: true });
  const degrees = peerDegreeMap(peerEdges);

  const tierCounts = { inner: 0, mid: 0, outer: 0 };
  const degreeBuckets = { none: 0, oneToTwo: 0, threePlus: 0 };
  const contactsWithNetwork: ContactWithNetwork[] = [];

  for (const c of contacts) {
    const breakdown = scores.get(c.id);
    if (!breakdown) continue;
    // Counted by absolute score, not by the contact's displayed (quota-assigned)
    // tier — quotas are fixed shares, so counting those would pin this
    // distribution to the same shape no matter how healthy the network is.
    tierCounts[closenessTier(breakdown.raw)] += 1;
    const peerDegree = degrees.get(c.id) || 0;
    // Bucketed over the sampled set only. Counting an unsampled contact as "no links"
    // would not mean they have none — it would mean nobody looked.
    if (sampledIds.has(c.id)) {
      if (peerDegree === 0) degreeBuckets.none += 1;
      else if (peerDegree <= 2) degreeBuckets.oneToTwo += 1;
      else degreeBuckets.threePlus += 1;
    }

    contactsWithNetwork.push({
      ...c,
      closeness: breakdown.closeness,
      tier: breakdown.tier,
      orbitScore: breakdown.orbitScore,
      goalRelevance: breakdown.goalRelevance,
      peerDegree,
    });
  }

  const totalPeerDegree = [...degrees.values()].reduce((a, b) => a + b, 0);
  // Averaged over the contacts that were actually analysed, not the whole network — the
  // divisor has to match the numerator or the figure drops as unanalysed contacts are added.
  const avgPeerDegree = sampled.length > 0 ? totalPeerDegree / sampled.length : 0;

  return {
    metrics: {
      tierCounts,
      totalContacts: contacts.length,
      totalPeerEdges: peerEdges.length,
      avgPeerDegree: Math.round(avgPeerDegree * 10) / 10,
      degreeBuckets,
      metricsSampleSize: sampled.length,
    },
    contactsWithNetwork,
  };
}
