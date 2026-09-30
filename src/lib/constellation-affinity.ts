/**
 * Which constellations belong near each other.
 *
 * The galaxy's one honest meaning for position is "near = related", so this decides what
 * related means. Three signals, each cheap to bucket (no all-pairs scan over people):
 *   - family: Google ↔ Google DeepMind. A fixed strong pull, deliberately not size-scaled —
 *     sister companies belong together whatever their headcounts.
 *   - alumni: two clusters whose members went to the same school (spellings grouped by
 *     `schoolGroupKeys`), by how many alumni the smaller side has. This is also what finally
 *     uses the school ties that clustering only shows for people nothing else claimed.
 *   - tags / interests: a value two clusters share. A value that spans more than
 *     `maxTagClusters` clusters ("friend", "mentor") says nothing about any pair, so it is
 *     dropped rather than linking half the sky.
 * Alumni and tag pulls are divided by √(sizeA·sizeB): a 300-person company shares a school
 * with everyone, and must not drag the whole map toward itself.
 *
 * The result is sparse on purpose — only each cluster's `perCluster` strongest links survive —
 * because the layout's force pass touches every edge every iteration.
 */

import { companyFamilyKey } from "@/lib/company-family";
import type { BuiltCluster } from "@/lib/constellation-clusters";
import { schoolGroupKeys } from "@/lib/school-key";

export type AffinityContact = {
  id: string;
  school?: string | null;
  tags?: string[] | null;
  sharedInterests?: string[] | null;
};

export type AffinityEdge = { a: string; b: string; weight: number };

export const AFFINITY = {
  /** Pull between two clusters of one company family. */
  family: 1,
  /** Coefficient on shared alumni ÷ √(sizeA·sizeB). */
  alumni: 1,
  /** Coefficient on shared tag/interest values ÷ √(sizeA·sizeB). */
  tags: 0.5,
  /** Links weaker than this are noise. */
  minWeight: 0.05,
  /** Strongest links kept per cluster (an edge survives if either end keeps it). */
  perCluster: 8,
  /** A school spanning more clusters than this keeps only its largest few. */
  maxSchoolClusters: 24,
  /** A tag/interest spanning more clusters than this is too generic to relate any pair. */
  maxTagClusters: 20,
  /** A family with more member clusters than this keeps only its largest few. */
  maxFamilyClusters: 12,
} as const;

const byWeight = (x: AffinityEdge, y: AffinityEdge) =>
  y.weight - x.weight || x.a.localeCompare(y.a) || x.b.localeCompare(y.b);

const ascending = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

export function buildClusterAffinity(
  contacts: AffinityContact[],
  byContactId: Map<string, { id: string }>,
  clusters: Array<Pick<BuiltCluster, "id" | "name" | "kind" | "count">>
): AffinityEdge[] {
  const size = new Map(clusters.map((c) => [c.id, c.count]));
  const total = new Map<string, AffinityEdge>();

  const bump = (x: string, y: string, amount: number) => {
    if (x === y) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = `${a.length}:${a}${b}`;
    const edge = total.get(key);
    if (edge) edge.weight += amount;
    else total.set(key, { a, b, weight: amount });
  };
  const pairs = (ids: string[], amountOf: (x: string, y: string) => number) => {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) bump(ids[i], ids[j], amountOf(ids[i], ids[j]));
    }
  };
  const scaled = (x: string, y: string) => 1 / Math.sqrt((size.get(x) ?? 1) * (size.get(y) ?? 1));

  // Family.
  const byFamily = new Map<string, Array<{ id: string; count: number }>>();
  for (const c of clusters) {
    if (c.kind !== "company") continue;
    const key = companyFamilyKey(c.name);
    if (!key) continue;
    const list = byFamily.get(key) ?? [];
    list.push({ id: c.id, count: c.count });
    byFamily.set(key, list);
  }
  for (const members of byFamily.values()) {
    if (members.length < 2) continue;
    const top = members
      .sort((x, y) => y.count - x.count || x.id.localeCompare(y.id))
      .slice(0, AFFINITY.maxFamilyClusters)
      .map((m) => m.id);
    pairs(top, () => AFFINITY.family);
  }

  const inScope = contacts.filter((c) => size.has(byContactId.get(c.id)?.id ?? ""));

  // Alumni.
  const trimmed = (c: AffinityContact) => (c.school ?? "").trim();
  const groups = schoolGroupKeys(inScope.map(trimmed).filter(Boolean));
  const bySchool = new Map<string, Map<string, number>>();
  for (const c of inScope) {
    const group = groups.get(trimmed(c));
    if (!group) continue;
    const clusterId = byContactId.get(c.id)!.id;
    const counts = bySchool.get(group) ?? new Map<string, number>();
    counts.set(clusterId, (counts.get(clusterId) ?? 0) + 1);
    bySchool.set(group, counts);
  }
  // Maps iterate in insertion order, which follows the contacts; float sums are not
  // associative, so accumulate in key order or the last digit depends on the input order.
  for (const group of [...bySchool.keys()].sort(ascending)) {
    const counts = bySchool.get(group)!;
    if (counts.size < 2) continue;
    const top = [...counts.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .slice(0, AFFINITY.maxSchoolClusters);
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        bump(
          top[i][0],
          top[j][0],
          (AFFINITY.alumni * Math.min(top[i][1], top[j][1])) * scaled(top[i][0], top[j][0])
        );
      }
    }
  }

  // Tags and interests.
  const byValue = new Map<string, Set<string>>();
  for (const c of inScope) {
    const clusterId = byContactId.get(c.id)!.id;
    const values = new Set(
      [...(c.tags ?? []), ...(c.sharedInterests ?? [])]
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean)
    );
    for (const value of values) {
      const set = byValue.get(value) ?? new Set<string>();
      set.add(clusterId);
      byValue.set(value, set);
    }
  }
  for (const value of [...byValue.keys()].sort(ascending)) {
    const set = byValue.get(value)!;
    if (set.size < 2 || set.size > AFFINITY.maxTagClusters) continue;
    pairs([...set].sort(), (x, y) => AFFINITY.tags * scaled(x, y));
  }

  // Sparse: each cluster keeps its strongest links.
  // Quantized so no last-digit residue of the sums can reorder links or tip the placement.
  for (const e of total.values()) e.weight = Math.round(e.weight * 1e9) / 1e9;
  const strong = [...total.values()].filter((e) => e.weight >= AFFINITY.minWeight);
  const incident = new Map<string, AffinityEdge[]>();
  for (const e of strong) {
    for (const id of [e.a, e.b]) {
      const list = incident.get(id) ?? [];
      list.push(e);
      incident.set(id, list);
    }
  }
  const keep = new Set<AffinityEdge>();
  for (const list of incident.values()) {
    list.sort(byWeight);
    for (const e of list.slice(0, AFFINITY.perCluster)) keep.add(e);
  }
  return [...keep].sort(byWeight);
}
