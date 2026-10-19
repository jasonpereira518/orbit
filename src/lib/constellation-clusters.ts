/**
 * Constellation cluster assignment.
 * Priority: Company → School → Industry → Deep Space.
 * Clusters are company names, schools, and — for people no company or school groups —
 * a shared industry ("Global Health", "Pharma & Biotech"), so they need not drift to Deep Space.
 * Exact company aliases (AWS ↔ Amazon Web Services) share one cluster.
 */

import { canonicalCompanyClusterName } from "@/lib/company-family";

export type ClusterKind = "company" | "school" | "industry" | "other";

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
  industry?: string | null;
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
export function assignCluster(c: Omit<ClusterContact, "id">): ClusterRef {
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
 * How many contacts share each company label, school and industry — the counts that
 * decide which of them a contact clusters under (`clusterRefFor`). Industry is free text
 * ("Public Health", "public health"), so it groups case-insensitively and is labelled by
 * the first spelling seen.
 */
export type ClusterCounts = {
  company: Map<string, number>;
  school: Map<string, number>;
  industry: Map<string, number>;
  industryLabel: Map<string, string>;
};

function industryKey(raw: string | null | undefined) {
  return trimLabel(raw).toLowerCase().replace(/\s+/g, " ");
}

/** `companyClusterLabel`, once per distinct spelling: the canonical-name rules are not cheap. */
function companyLabeller() {
  const labels = new Map<string | null | undefined, string>();
  return (raw: string | null | undefined) => {
    let label = labels.get(raw);
    if (label === undefined) {
      label = companyClusterLabel(raw);
      labels.set(raw, label);
    }
    return label;
  };
}

/** `ClusterCounts` over a list of contacts, in list order. */
export function clusterCountsOf(contacts: ClusterContact[], companyLabel = companyLabeller()): ClusterCounts {
  const counts: ClusterCounts = { company: new Map(), school: new Map(), industry: new Map(), industryLabel: new Map() };
  for (const c of contacts) {
    const company = companyLabel(c.company);
    if (company) counts.company.set(company, (counts.company.get(company) || 0) + 1);
    const school = trimLabel(c.school);
    if (school) counts.school.set(school, (counts.school.get(school) || 0) + 1);
    const industry = industryKey(c.industry);
    if (industry) {
      counts.industry.set(industry, (counts.industry.get(industry) || 0) + 1);
      if (!counts.industryLabel.has(industry)) counts.industryLabel.set(industry, trimLabel(c.industry));
    }
  }
  return counts;
}

/**
 * `ClusterCounts` from per-value tallies (a `GROUP BY` over the raw columns), so a caller can
 * cluster a few contacts against the whole network without reading every contact. Equal to
 * `clusterCountsOf` over the same contacts when each industry spelling carries its first
 * position in that list (`first`, smaller is earlier).
 */
export function clusterCountsFromTallies(tallies: {
  company: Array<{ value: string | null; n: number }>;
  school: Array<{ value: string | null; n: number }>;
  industry: Array<{ value: string | null; n: number; first: number }>;
}): ClusterCounts {
  const counts: ClusterCounts = { company: new Map(), school: new Map(), industry: new Map(), industryLabel: new Map() };
  const companyLabel = companyLabeller();
  for (const { value, n } of tallies.company) {
    const company = companyLabel(value);
    if (company) counts.company.set(company, (counts.company.get(company) || 0) + n);
  }
  for (const { value, n } of tallies.school) {
    const school = trimLabel(value);
    if (school) counts.school.set(school, (counts.school.get(school) || 0) + n);
  }
  const firstSeen = new Map<string, number>();
  for (const { value, n, first } of tallies.industry) {
    const industry = industryKey(value);
    if (!industry) continue;
    counts.industry.set(industry, (counts.industry.get(industry) || 0) + n);
    if (!firstSeen.has(industry) || first < firstSeen.get(industry)!) {
      firstSeen.set(industry, first);
      counts.industryLabel.set(industry, trimLabel(value));
    }
  }
  return counts;
}

/**
 * The one cluster a contact is drawn in: its company when two or more share it, else its
 * school when two or more share that, else its industry likewise, else `assignCluster`.
 */
export function clusterRefFor(c: Omit<ClusterContact, "id">, counts: ClusterCounts, companyLabel = companyClusterLabel): ClusterRef {
  const company = companyLabel(c.company);
  const school = trimLabel(c.school);
  if (company && (counts.company.get(company) || 0) >= 2) {
    return { id: normalizeKey("company", company), name: company, kind: "company" };
  }
  if (school && (counts.school.get(school) || 0) >= 2) {
    return { id: normalizeKey("school", school), name: school, kind: "school" };
  }
  if ((counts.industry.get(industryKey(c.industry)) || 0) >= 2) {
    const name = counts.industryLabel.get(industryKey(c.industry))!;
    return { id: normalizeKey("industry", name), name, kind: "industry" };
  }
  return assignCluster(c);
}

/**
 * Build clusters from contacts, sorted by size (desc).
 * Singleton company people fall through to School when that school
 * has ≥2 peers, so constellations stay meaningful.
 */
export function buildConstellationClusters(
  contacts: ClusterContact[]
): { clusters: BuiltCluster[]; byContactId: Map<string, ClusterRef> } {
  const companyLabel = companyLabeller();
  const counts = clusterCountsOf(contacts, companyLabel);
  const byContactId = new Map<string, ClusterRef>();
  for (const c of contacts) byContactId.set(c.id, clusterRefFor(c, counts, companyLabel));

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
    industry: 2,
    other: 3,
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
      (c): c is BuiltCluster & { kind: "company" | "school" | "industry" } =>
        c.kind !== "other" &&
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
