import { daysAgo } from "@/lib/duplicates";

/**
 * Days without contact before someone becomes a red comet on the map.
 * Very strict — only long-dormant relationships (1 year+).
 */
export const COMET_DORMANT_DAYS = 365;

/**
 * True when a contact is drifting away (red comet).
 * Requires a known last interaction that is very old — never-touched
 * contacts are not treated as comets.
 */
export function isCometContact(
  lastInteractionAt: Date | string | null | undefined
): boolean {
  if (!lastInteractionAt) return false;
  return daysAgo(lastInteractionAt) >= COMET_DORMANT_DAYS;
}

/**
 * At most this many red comets per cluster on the constellation.
 *
 * A year without contact is common, not exceptional: an imported network can have hundreds of
 * year-old connections at one employer, and marking all of them turned whole constellations red
 * and filled the Re-engage list with a four-figure count nobody could act on. A comet is a nudge,
 * so each cluster gets a few.
 */
export const COMETS_PER_CLUSTER = 3;

type CometCandidate = {
  id: string;
  lastInteractionAt: Date | string | null | undefined;
  orbitScore?: number | null;
  relationshipScore?: number | null;
};

/**
 * Which dormant contacts the constellation shows as comets: in each cluster, the
 * `perCluster` most worth re-engaging — closest relationship first, then the longest gone
 * quiet. Contacts in no cluster share one group, so the rim of the sky gets a few too.
 */
export function pickClusterComets<T extends CometCandidate>(
  contacts: T[],
  clusters: Array<{ id: string; contactIds: string[] }>,
  perCluster = COMETS_PER_CLUSTER
): Set<string> {
  const groupOf = new Map<string, string>();
  for (const cluster of clusters) {
    for (const id of cluster.contactIds) groupOf.set(id, cluster.id);
  }
  const groups = new Map<string, T[]>();
  for (const c of contacts) {
    if (!isCometContact(c.lastInteractionAt)) continue;
    const key = groupOf.get(c.id) ?? "__unclustered__";
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  }
  const score = (c: T) => c.orbitScore ?? c.relationshipScore ?? 0;
  const picked = new Set<string>();
  for (const group of groups.values()) {
    group
      .sort(
        (a, b) =>
          score(b) - score(a) ||
          daysAgo(b.lastInteractionAt) - daysAgo(a.lastInteractionAt) ||
          (a.id < b.id ? -1 : 1)
      )
      .slice(0, perCluster)
      .forEach((c) => picked.add(c.id));
  }
  return picked;
}
