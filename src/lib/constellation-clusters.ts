/**
 * Constellation cluster assignment.
 * Priority: Company → School → Deep Space.
 * Clusters are only company names and schools — nothing else.
 * Exact company aliases (AWS ↔ Amazon Web Services) share one cluster.
 */

import { canonicalCompanyClusterName } from "@/lib/company-family";

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

/** Company label used for clustering — aliases collapse to one name. */
function companyClusterLabel(raw: string | null | undefined): string {
  return canonicalCompanyClusterName(raw) || trimLabel(raw);
}

/**
 * Assign each contact to exactly one constellation cluster.
 * Company wins when present; else School; else Deep Space.
 */
export function assignCluster(c: ClusterContact): ClusterRef {
  const company = companyClusterLabel(c.company);
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
    const company = companyClusterLabel(c.company);
    if (company) {
      companyCounts.set(company, (companyCounts.get(company) || 0) + 1);
    }
    const school = trimLabel(c.school);
    if (school) schoolCounts.set(school, (schoolCounts.get(school) || 0) + 1);
  }

  const byContactId = new Map<string, ClusterRef>();

  for (const c of contacts) {
    const company = companyClusterLabel(c.company);
    const school = trimLabel(c.school);

    let ref: ClusterRef;

    if (company && (companyCounts.get(company) || 0) >= 2) {
      ref = {
        id: normalizeKey("company", company),
        name: company,
        kind: "company",
      };
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

/**
 * The minimum a "constellation" can be.
 *
 * A figure is traced between people, so one person is a star, not a constellation.
 */
const MIN_CLUSTER_MEMBERS = 2;

/**
 * Company/school clusters shaped for graph + dashboard payloads.
 *
 * Filtered by COUNT as well as kind. The assignment above only applies its `>= 2` rule to
 * the preferred company/school branches; anything that falls through to `assignCluster`
 * gets a company cluster even as a party of one. So the Clusters chip read 19-20 while
 * the canvas drew 8 figures, and eleven of the entries in the popover had a count of 1 —
 * clicking one zoomed the camera to a single isolated star.
 *
 * This also resolves the duplicate the popover showed for the same name: "UNC Chapel Hill"
 * appeared as both COMPANY (3) and SCHOOL (1), because school is only a fallback and the
 * one alumnus whose employer cluster was too small landed in a separate school cluster of
 * their own. The singleton is no longer named, so the pair collapses.
 */
export function toNamedGraphClusters(clusters: BuiltCluster[]) {
  return clusters
    .filter(
      (c): c is BuiltCluster & { kind: "company" | "school" } =>
        (c.kind === "company" || c.kind === "school") &&
        c.count >= MIN_CLUSTER_MEMBERS
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
