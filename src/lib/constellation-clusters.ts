/**
 * Constellation cluster assignment. Every contact gets exactly one home; first match wins:
 *
 *   1. Company — ≥2 contacts share the canonical company (AWS ↔ Amazon Web Services collapse).
 *   2. Family satellite — alone at a company whose family (`companyFamilyRoot`) already has a
 *      company cluster: keeps its own company ref, and the layout seats it in that family's
 *      field (`familySatellites` in graph-layout.ts). A sister company is a stronger tie than a
 *      shared function, so the lone DeepMind engineer sits by Google, not in Engineers.
 *   3. Role — ≥2 of the rest share a function (role-function.ts): a cross-company cluster such
 *      as Engineers or Founders & Execs. An unknown function never forms one.
 *   4. School — ≥2 of what remains share a school, spellings grouped (school-key.ts).
 *   5. Industry — ≥2 of what remains share an industry ("Global Health", "Pharma & Biotech"),
 *      so people no company, role or school groups need not drift to Deep Space.
 *   6. Otherwise their own singleton company or school ref, or Deep Space. Singletons are not
 *      constellations (`isWedgeEligible`) and scatter as background stars.
 *
 * Every count is taken over the people still unassigned at that tier, so a tier only groups
 * people nobody earlier claimed.
 *
 * The dashboard preview does NOT run this: it picks whom to draw from per-value SQL tallies
 * (`clusterCountsFromTallies` / `clusterRefFor` below: company → school → industry over raw
 * values) so it never reads every contact. The drawn few are then regrouped by this function
 * in the browser. ponytail: the preview's selection ignores role clusters; to include them,
 * `loadChartGroups` would have to group by title as well (up to one row per contact).
 */

import {
  canonicalCompanyClusterName,
  companyFamilyRoot,
} from "@/lib/company-family";
import {
  classifyTitle,
  roleClusterKey,
  ROLE_CLUSTER_NAMES,
  type RoleClusterKey,
} from "@/lib/role-function";
import { schoolGroupKeys } from "@/lib/school-key";

export type ClusterKind = "company" | "role" | "school" | "industry" | "other";

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
  title?: string | null;
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

function companyRef(company: string): ClusterRef {
  return { id: normalizeKey("company", company), name: company, kind: "company" };
}

function roleRef(key: RoleClusterKey): ClusterRef {
  return { id: normalizeKey("role", key), name: ROLE_CLUSTER_NAMES[key], kind: "role" };
}

const DEEP_SPACE_REF: ClusterRef = {
  id: normalizeKey("other", DEEP_SPACE),
  name: DEEP_SPACE,
  kind: "other",
};

function countBy<T>(items: T[], key: (item: T) => string | null) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/** Most common raw spelling per school group; ties go to the alphabetically first. */
export function schoolDisplayNames(
  members: ClusterContact[],
  groupOf: (c: ClusterContact) => string | null
) {
  const spellings = new Map<string, Map<string, number>>();
  for (const c of members) {
    const group = groupOf(c);
    if (!group) continue;
    const raw = trimLabel(c.school);
    const counts = spellings.get(group) ?? new Map<string, number>();
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
    spellings.set(group, counts);
  }
  const names = new Map<string, string>();
  for (const [group, counts] of spellings) {
    const [best] = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
    names.set(group, best![0]);
  }
  return names;
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
 * Build clusters from contacts, sorted by size (desc). See the tiers at the top of this file.
 */
export function buildConstellationClusters(
  contacts: ClusterContact[]
): { clusters: BuiltCluster[]; byContactId: Map<string, ClusterRef> } {
  const byContactId = new Map<string, ClusterRef>();

  // 1–2. Company clusters, and lone members of a family that has one. The label and family
  // lookups are alias-table scans, so each is memoised for the call: at 10k contacts they were
  // the bulk of the grouping time, and most contacts repeat a small set of companies.
  const labelOf = companyLabeller();
  const rootCache = new Map<string, string | null>();
  const rootOf = (company: string) => {
    let root = rootCache.get(company);
    if (root === undefined) {
      root = companyFamilyRoot(company);
      rootCache.set(company, root);
    }
    return root;
  };

  const companyOf = new Map(contacts.map((c) => [c.id, labelOf(c.company)]));
  const companyCounts = countBy(contacts, (c) => companyOf.get(c.id) || null);
  const familiesWithCluster = new Set<string>();
  for (const [company, count] of companyCounts) {
    if (count < 2) continue;
    const root = rootOf(company);
    if (root) familiesWithCluster.add(root);
  }

  const afterCompany: ClusterContact[] = [];
  for (const c of contacts) {
    const company = companyOf.get(c.id) || "";
    // A root only matters to a lone company, and only when some family has a cluster.
    const inCluster =
      !!company &&
      ((companyCounts.get(company) ?? 0) >= 2 ||
        (familiesWithCluster.size > 0 && familiesWithCluster.has(rootOf(company) ?? "")));
    if (inCluster) byContactId.set(c.id, companyRef(company));
    else afterCompany.push(c);
  }

  // 3. Role clusters across companies. Titles repeat heavily, so classify each once.
  const roleByTitle = new Map<string, RoleClusterKey | null>();
  const roleOf = new Map<string, RoleClusterKey | null>();
  for (const c of afterCompany) {
    const title = trimLabel(c.title);
    let role = roleByTitle.get(title);
    if (role === undefined) {
      role = roleClusterKey(classifyTitle(title));
      roleByTitle.set(title, role);
    }
    roleOf.set(c.id, role);
  }
  const roleCounts = countBy(afterCompany, (c) => roleOf.get(c.id) ?? null);
  const afterRole: ClusterContact[] = [];
  for (const c of afterCompany) {
    const role = roleOf.get(c.id);
    if (role && (roleCounts.get(role) ?? 0) >= 2) byContactId.set(c.id, roleRef(role));
    else afterRole.push(c);
  }

  // 4. School clusters, spellings grouped. Acronym uniqueness (MIT vs a second
  // "MIT") is judged over the people who reach this tier only, which is deterministic; people
  // a role cluster absorbed do not affect school merges.
  const schoolGroups = schoolGroupKeys(
    afterRole.map((c) => trimLabel(c.school)).filter(Boolean)
  );
  const groupOf = (c: ClusterContact) => schoolGroups.get(trimLabel(c.school)) ?? null;
  const schoolCounts = countBy(afterRole, groupOf);
  const schoolNames = schoolDisplayNames(afterRole, groupOf);
  const afterSchool: ClusterContact[] = [];
  for (const c of afterRole) {
    const group = groupOf(c);
    if (group && (schoolCounts.get(group) ?? 0) >= 2) {
      byContactId.set(c.id, {
        id: normalizeKey("school", group),
        name: schoolNames.get(group)!,
        kind: "school",
      });
    } else afterSchool.push(c);
  }

  // 5. Industry clusters (free text, grouped case-insensitively, labelled by the first
  // spelling seen); 6. fallbacks.
  const industryCounts = countBy(afterSchool, (c) => industryKey(c.industry) || null);
  const industryLabels = new Map<string, string>();
  for (const c of afterSchool) {
    const key = industryKey(c.industry);
    if (key && !industryLabels.has(key)) industryLabels.set(key, trimLabel(c.industry));
  }
  for (const c of afterSchool) {
    const group = groupOf(c);
    const company = companyOf.get(c.id) || "";
    const industry = industryKey(c.industry);
    if (industry && (industryCounts.get(industry) ?? 0) >= 2) {
      const name = industryLabels.get(industry)!;
      byContactId.set(c.id, { id: normalizeKey("industry", name), name, kind: "industry" });
    } else if (company) {
      byContactId.set(c.id, companyRef(company));
    } else if (group) {
      byContactId.set(c.id, {
        id: normalizeKey("school", group),
        name: trimLabel(c.school),
        kind: "school",
      });
    } else {
      byContactId.set(c.id, DEEP_SPACE_REF);
    }
  }

  const map = new Map<string, BuiltCluster>();
  for (const c of contacts) {
    const ref = byContactId.get(c.id)!;
    const existing = map.get(ref.id);
    if (existing) {
      existing.contactIds.push(c.id);
      existing.count += 1;
    } else {
      map.set(ref.id, { ...ref, count: 1, contactIds: [c.id] });
    }
  }

  const kindRank: Record<ClusterKind, number> = {
    company: 0,
    role: 1,
    school: 2,
    industry: 3,
    other: 4,
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
 * Named clusters shaped for graph + dashboard payloads.
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
      (c): c is BuiltCluster & { kind: "company" | "role" | "school" | "industry" } =>
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
