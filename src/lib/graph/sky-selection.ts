/**
 * Turning a tap into the object the inspect panel expects.
 *
 * Shared so both renderers hand `ContactInspectPanel` an identical payload — the "You"
 * summary in particular is 12 fields of plumbing that would rot the moment it existed
 * twice.
 */
import type { InspectSelection } from "@/components/graph/contact-inspect-panel";
import type { GraphPayload } from "@/components/graph/graph-chart-types";
import type { GraphNodeData } from "@/lib/graph-layout";

/**
 * The sun's panel.
 *
 * Every count comes from the server's summary, computed over the whole network — never
 * a client recompute over `data.contacts`. The recompute used to sit directly beneath
 * `total`, which has always been the full network, so the two disagreed whenever the
 * payload was a subset: the dashboard preview caps at 150, and the constellation filter
 * narrows it further. A ring histogram summing to 150 under a headline of 1,240 reads as
 * a bug in the numbers rather than as two different questions.
 */
export function selectionForUser(
  data: GraphNodeData,
  summary: GraphPayload["summary"]
): InspectSelection {
  return {
    type: "user",
    data,
    summary: {
      total: summary.total,
      companyCount: summary.companyCount,
      scoreCounts: summary.scoreCounts,
      strongTies: summary.strongTies,
      dormantCount: summary.dormantCount,
      overdueCount: summary.overdueCount,
      userImageUrl: summary.userImageUrl,
      userEmail: summary.userEmail,
      socialLinks: summary.socialLinks,
      goals: summary.goals,
    },
  };
}

export function selectionForContact(id: string, data: GraphNodeData): InspectSelection {
  return { type: "contact", id, data };
}

/** `nebula-acme` / `cluster-acme` → `acme`. */
export function clusterIdFromNodeId(nodeId: string, explicit?: string): string {
  return explicit || nodeId.replace(/^(cluster|nebula)-/, "");
}
