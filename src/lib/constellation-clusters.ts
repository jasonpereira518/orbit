/**
 * Constellation cluster assignment.
 * Priority: Company → School → Deep Space.
 * Clusters are only company names and schools — nothing else.
 */

export type ClusterKind = "company" | "school" | "other";

export type ClusterRef = {
  /** Stable map key */
  id: string;
  /** Display name on the map */
  name: string;
  kind: ClusterKind;
};

export type ClusterContact = {
  id: string;
  company?: string | null;
  school?: string | null;
};

const DEEP_SPACE = "Deep Space";

function trimLabel(value: string | null | undefined) {
  return (value || "").trim();
}

function normalizeKey(kind: ClusterKind, name: string) {
  return `${kind}:${name.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/**
 * Assign each contact to exactly one constellation cluster.
 * Company wins when present; else School; else Deep Space.
 */
export function assignCluster(c: ClusterContact): ClusterRef {
  const company = trimLabel(c.company);
  if (company) {
    return {
      id: normalizeKey("company", company),
      name: company,
      kind: "company",
    };
  }

  const school = trimLabel(c.school);
  if (school) {
    return {
      id: normalizeKey("school", school),
      name: school,
      kind: "school",
    };
  }

  return {
    id: normalizeKey("other", DEEP_SPACE),
    name: DEEP_SPACE,
    kind: "other",
  };
}

export type BuiltCluster = ClusterRef & {
  count: number;
  contactIds: string[];
};

/**
 * Build clusters from contacts, sorted by size (desc).
 * Singleton company people fall through to School when that school
 * has ≥2 peers, so constellations stay meaningful.
 */
export function buildConstellationClusters(
  contacts: ClusterContact[]
): { clusters: BuiltCluster[]; byContactId: Map<string, ClusterRef> } {
  const companyCounts = new Map<string, number>();
  const schoolCounts = new Map<string, number>();

  for (const c of contacts) {
    const company = trimLabel(c.company);
    if (company) companyCounts.set(company, (companyCounts.get(company) || 0) + 1);
    const school = trimLabel(c.school);
    if (school) schoolCounts.set(school, (schoolCounts.get(school) || 0) + 1);
  }

  const byContactId = new Map<string, ClusterRef>();

  for (const c of contacts) {
    const company = trimLabel(c.company);
    const school = trimLabel(c.school);

    let ref: ClusterRef;

    if (company && (companyCounts.get(company) || 0) >= 2) {
      ref = { id: normalizeKey("company", company), name: company, kind: "company" };
    } else if (school && (schoolCounts.get(school) || 0) >= 2) {
      ref = { id: normalizeKey("school", school), name: school, kind: "school" };
    } else {
      ref = assignCluster(c);
    }

    byContactId.set(c.id, ref);
  }

  const map = new Map<string, BuiltCluster>();
  for (const c of contacts) {
    const ref = byContactId.get(c.id);
    if (!ref) continue;
    const existing = map.get(ref.id);
    if (existing) {
      existing.contactIds.push(c.id);
      existing.count += 1;
    } else {
      map.set(ref.id, {
        ...ref,
        count: 1,
        contactIds: [c.id],
      });
    }
  }

  const kindRank: Record<ClusterKind, number> = {
    company: 0,
    school: 1,
    other: 2,
  };

  const clusters = [...map.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const kr = kindRank[a.kind] - kindRank[b.kind];
    if (kr !== 0) return kr;
    return a.name.localeCompare(b.name);
  });

  return { clusters, byContactId };
}

/** Company/school clusters shaped for graph + dashboard payloads. */
export function toNamedGraphClusters(clusters: BuiltCluster[]) {
  return clusters
    .filter(
      (c): c is BuiltCluster & { kind: "company" | "school" } =>
        c.kind === "company" || c.kind === "school"
    )
    .map((c) => ({
      id: c.id,
      name: c.name,
      company: c.name,
      kind: c.kind,
      count: c.count,
      contactIds: c.contactIds,
    }));
}
