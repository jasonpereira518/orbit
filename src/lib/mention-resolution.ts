/**
 * Resolves people *mentioned* in a note (not spoken to) to existing contacts.
 *
 * Looser than `findDuplicateCandidatesIndexed` on purpose: that decides whether to MERGE
 * two records, where a false positive corrupts data. A mention only LINKS, and a wrong link
 * is one click to remove — so a unique exact name, or a unique first name, is enough.
 * Ambiguity always resolves to "unresolved"; the results view offers those as new contacts.
 */
import {
  buildDuplicateIndex,
  findDuplicateCandidatesIndexed,
  type DuplicateSubject,
} from "@/lib/duplicates";

export type MentionCandidate = { name: string; context: string | null; company?: string | null; nearPerson?: string | null };
export type MentionMatchedBy = "exact_name" | "name_company" | "first_name_unique";
export type ResolvedMention = { text: string; context: string | null; nearPerson: string | null; contactId: string; confidence: number; matchedBy: MentionMatchedBy };
export type UnresolvedMention = { text: string; context: string | null; nearPerson: string | null };

function normalizeName(s: string | null | undefined) {
  return (s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function normalizeCompany(s: string | null | undefined) {
  return (s || "").trim().toLowerCase();
}

export function resolveMentions(
  subjects: DuplicateSubject[],
  mentions: MentionCandidate[],
  ctx?: { excludeContactIds?: Iterable<string> }
): { resolved: ResolvedMention[]; unresolved: UnresolvedMention[] } {
  const excluded = new Set(ctx?.excludeContactIds ?? []);
  const pool = subjects.filter((s) => !excluded.has(s.id));
  const index = buildDuplicateIndex(pool);
  const byFullName = new Map<string, DuplicateSubject[]>();
  const byFirstName = new Map<string, DuplicateSubject[]>();
  for (const s of pool) {
    const full = normalizeName(s.fullName);
    if (!full) continue;
    byFullName.set(full, [...(byFullName.get(full) ?? []), s]);
    const first = full.split(" ")[0];
    byFirstName.set(first, [...(byFirstName.get(first) ?? []), s]);
  }

  const resolved: ResolvedMention[] = [];
  const unresolved: UnresolvedMention[] = [];
  const seen = new Set<string>();

  for (const m of mentions) {
    const text = m.name.trim();
    const norm = normalizeName(text);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    const company = normalizeCompany(m.company);
    const base = { text, context: m.context ?? null, nearPerson: m.nearPerson ?? null };
    const onlyWithCompany = (list: DuplicateSubject[]) =>
      company ? list.filter((s) => normalizeCompany(s.company) === company) : list;

    // Tier 1: name + company through the duplicate matcher (≥ 0.85 = its own merge bar).
    if (company && norm.includes(" ")) {
      const top = findDuplicateCandidatesIndexed(index, { fullName: text, company: m.company })[0];
      if (top && top.confidence >= 0.85) {
        resolved.push({ ...base, contactId: top.contact.id, confidence: 0.9, matchedBy: "name_company" });
        continue;
      }
    }
    // Tier 2: exact full name, unique (company narrows when given).
    const fullMatches = onlyWithCompany(byFullName.get(norm) ?? []);
    if (fullMatches.length === 1) {
      resolved.push({ ...base, contactId: fullMatches[0].id, confidence: company ? 0.9 : 0.8, matchedBy: company ? "name_company" : "exact_name" });
      continue;
    }
    if (fullMatches.length > 1) { unresolved.push(base); continue; }
    // Tier 3: a single-token mention that is a unique first name.
    if (!norm.includes(" ")) {
      const firstMatches = onlyWithCompany(byFirstName.get(norm) ?? []);
      if (firstMatches.length === 1) {
        resolved.push({ ...base, contactId: firstMatches[0].id, confidence: 0.7, matchedBy: "first_name_unique" });
        continue;
      }
    }
    unresolved.push(base);
  }
  return { resolved, unresolved };
}
