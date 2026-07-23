import type { PeerEdgeReason } from "@/lib/network-metrics";

export type RelatedReason =
  | PeerEdgeReason
  | "school"
  | "companyId";

export type RelatedContactCandidate = {
  id: string;
  fullName: string;
  preferredName?: string | null;
  firstName?: string | null;
  title?: string | null;
  company?: string | null;
  companyId?: string | null;
  school?: string | null;
  location?: string | null;
  howMet?: string | null;
  profileImageUrl?: string | null;
  linkedinUrl?: string | null;
  email?: string | null;
  phone?: string | null;
  tags?: string[] | null;
  sharedInterests?: string[] | null;
  notes?: string | null;
  aiSummary?: string | null;
  keyFacts?: string[] | null;
  relationshipScore?: number | null;
};

export type RelatedContact = {
  id: string;
  fullName: string;
  preferredName: string | null;
  firstName: string | null;
  title: string | null;
  company: string | null;
  school: string | null;
  location: string | null;
  profileImageUrl: string | null;
  linkedinUrl: string | null;
  email: string | null;
  phone: string | null;
  aiSummary: string | null;
  relationshipScore: number | null;
  reason: RelatedReason;
  reasonLabel: string;
};

const REASON_WEIGHT: Record<RelatedReason, number> = {
  mention: 100,
  companyId: 90,
  company: 80,
  event: 75,
  howMet: 70,
  school: 60,
  sharedTags: 40,
  sharedInterests: 30,
};

function normalizePhrase(value: string | null | undefined) {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function companyKey(company: string | null | undefined) {
  return normalizePhrase(company);
}

function sharedCount(a: string[], b: string[]) {
  const setB = new Set(b.map((t) => t.toLowerCase()));
  let n = 0;
  for (const t of a) {
    if (setB.has(t.toLowerCase())) n += 1;
  }
  return n;
}

function contactCorpus(c: RelatedContactCandidate) {
  return [
    c.aiSummary || "",
    ...(c.keyFacts || []),
    c.notes || "",
    ...(c.sharedInterests || []),
  ]
    .join(" ")
    .toLowerCase();
}

function nameAliases(c: RelatedContactCandidate) {
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

function mentionsOther(a: RelatedContactCandidate, b: RelatedContactCandidate) {
  const text = contactCorpus(a);
  if (!text) return false;
  return nameAliases(b).some((alias) => {
    if (alias.length < 3) return false;
    return text.includes(alias);
  });
}

function reasonLabel(
  reason: RelatedReason,
  source: RelatedContactCandidate
): string {
  switch (reason) {
    case "mention":
      return "Mentioned together";
    case "companyId":
    case "company":
      return source.company?.trim()
        ? `Same company · ${source.company.trim()}`
        : "Same company";
    case "howMet":
    case "event":
      return source.howMet?.trim()
        ? `Met via · ${source.howMet.trim()}`
        : "Same intro context";
    case "school":
      return source.school?.trim()
        ? `Same school · ${source.school.trim()}`
        : "Same school";
    case "sharedTags":
      return "Shared tags";
    case "sharedInterests":
      return "Shared interests";
  }
}

function bestReason(
  source: RelatedContactCandidate,
  other: RelatedContactCandidate
): RelatedReason | null {
  if (mentionsOther(source, other) || mentionsOther(other, source)) {
    return "mention";
  }
  if (
    source.companyId &&
    other.companyId &&
    source.companyId === other.companyId
  ) {
    return "companyId";
  }
  const sourceCompany = companyKey(source.company);
  const otherCompany = companyKey(other.company);
  if (sourceCompany && sourceCompany === otherCompany) {
    return "company";
  }
  const sourceHowMet = normalizePhrase(source.howMet);
  const otherHowMet = normalizePhrase(other.howMet);
  if (sourceHowMet.length >= 3 && sourceHowMet === otherHowMet) {
    return "howMet";
  }
  const sourceSchool = normalizePhrase(source.school);
  const otherSchool = normalizePhrase(other.school);
  if (sourceSchool.length >= 3 && sourceSchool === otherSchool) {
    return "school";
  }
  if (sharedCount(source.tags || [], other.tags || []) >= 2) {
    return "sharedTags";
  }
  if (
    sharedCount(source.sharedInterests || [], other.sharedInterests || []) >= 2
  ) {
    return "sharedInterests";
  }
  return null;
}

/**
 * Rank contacts related to `contactId` from shared company, school, howMet,
 * mentions, tags, and interests. Mixes connection strength with intro usefulness.
 */
export function findRelatedContacts(
  contactId: string,
  contacts: RelatedContactCandidate[],
  limit = 6,
  activeGoals: string[] = []
): RelatedContact[] {
  const source = contacts.find((c) => c.id === contactId);
  if (!source) return [];

  const goalTokens = activeGoals
    .flatMap((g) =>
      g
        .toLowerCase()
        .split(/[^a-z0-9+#.]+/i)
        .filter((t) => t.length > 2)
    )
    .slice(0, 40);

  const scored: Array<RelatedContact & { score: number }> = [];

  for (const other of contacts) {
    if (other.id === contactId) continue;
    const reason = bestReason(source, other);
    if (!reason) continue;

    const weight = REASON_WEIGHT[reason];
    const strengthBoost = (other.relationshipScore ?? 2) * 4;

    const otherCorpus = contactCorpus(other);
    let introBoost = 0;
    if (goalTokens.length > 0 && otherCorpus) {
      const hits = goalTokens.filter((t) => otherCorpus.includes(t)).length;
      introBoost = hits * 8;
    }
    // Mentions and shared company/school are especially useful intro paths
    if (reason === "mention") introBoost += 25;
    if (reason === "company" || reason === "companyId") introBoost += 12;
    if (reason === "school") introBoost += 8;

    scored.push({
      id: other.id,
      fullName: other.fullName,
      preferredName: other.preferredName ?? null,
      firstName: other.firstName ?? null,
      title: other.title ?? null,
      company: other.company ?? null,
      school: other.school ?? null,
      location: other.location ?? null,
      profileImageUrl: other.profileImageUrl ?? null,
      linkedinUrl: other.linkedinUrl ?? null,
      email: other.email ?? null,
      phone: other.phone ?? null,
      aiSummary: other.aiSummary ?? null,
      relationshipScore: other.relationshipScore ?? null,
      reason,
      reasonLabel: reasonLabel(reason, source),
      score: weight + strengthBoost + introBoost,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.fullName.localeCompare(b.fullName));

  return scored.slice(0, limit).map(({ score: _score, ...rest }) => rest);
}
