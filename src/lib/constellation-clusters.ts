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
 *   5. Otherwise their own singleton company or school ref, or Deep Space. Singletons are not
 *      constellations (`isWedgeEligible`) and scatter as background stars.
 *
 * Every count is taken over the people still unassigned at that tier, so a tier only groups
 * people nobody earlier claimed.
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

export type ClusterKind = "company" | "role" | "school" | "other";

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
function schoolDisplayNames(
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

export function buildConstellationClusters(
  contacts: ClusterContact[]
): { clusters: BuiltCluster[]; byContactId: Map<string, ClusterRef> } {
  const byContactId = new Map<string, ClusterRef>();

  // 1–2. Company clusters, and lone members of a family that has one.
  const companyOf = new Map(contacts.map((c) => [c.id, companyClusterLabel(c.company)]));
  const companyCounts = countBy(contacts, (c) => companyOf.get(c.id) || null);
  const familiesWithCluster = new Set<string>();
  for (const [company, count] of companyCounts) {
    if (count < 2) continue;
    const root = companyFamilyRoot(company);
    if (root) familiesWithCluster.add(root);
  }

  const afterCompany: ClusterContact[] = [];
  for (const c of contacts) {
    const company = companyOf.get(c.id) || "";
    const root = company ? companyFamilyRoot(company) : null;
    if (company && ((companyCounts.get(company) ?? 0) >= 2 || (root && familiesWithCluster.has(root)))) {
      byContactId.set(c.id, companyRef(company));
    } else {
      afterCompany.push(c);
    }
  }

  // 3. Role clusters across companies.
  const roleOf = new Map(afterCompany.map((c) => [c.id, roleClusterKey(classifyTitle(c.title))]));
  const roleCounts = countBy(afterCompany, (c) => roleOf.get(c.id) ?? null);
  const afterRole: ClusterContact[] = [];
  for (const c of afterCompany) {
    const role = roleOf.get(c.id);
    if (role && (roleCounts.get(role) ?? 0) >= 2) byContactId.set(c.id, roleRef(role));
    else afterRole.push(c);
  }

  // 4. School clusters, spellings grouped; 5. fallbacks.
  const schoolGroups = schoolGroupKeys(
    afterRole.map((c) => trimLabel(c.school)).filter(Boolean)
  );
  const groupOf = (c: ClusterContact) => schoolGroups.get(trimLabel(c.school)) ?? null;
  const schoolCounts = countBy(afterRole, groupOf);
  const schoolNames = schoolDisplayNames(afterRole, groupOf);
  for (const c of afterRole) {
    const group = groupOf(c);
    const company = companyOf.get(c.id) || "";
    if (group && (schoolCounts.get(group) ?? 0) >= 2) {
      byContactId.set(c.id, {
        id: normalizeKey("school", group),
        name: schoolNames.get(group)!,
        kind: "school",
      });
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

/** Named clusters (everything but Deep Space) shaped for graph + dashboard payloads. */
export function toNamedGraphClusters(clusters: BuiltCluster[]) {
  return clusters
    .filter(
      (c): c is BuiltCluster & { kind: "company" | "role" | "school" } =>
        c.kind !== "other"
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
