import {
  rankKeywordSearch,
  type KeywordSearchHit,
  type SearchableContact,
} from "@/lib/keyword-search";
import type { RankedContact } from "@/lib/hybrid-search";

/**
 * 1–2 token queries are lookups (a name, a company); the lexical arms handle
 * them and the embedding round trip adds latency for nothing. Three or more
 * tokens reads as a question — bring in the semantic arm.
 */
export function shouldUseSemanticArm(query: string): boolean {
  return query.trim().split(/\s+/).length >= 3;
}

function toSearchable(c: RankedContact): SearchableContact {
  return {
    id: c.id,
    fullName: c.fullName,
    preferredName: c.preferredName,
    company: c.company,
    school: c.school,
    title: c.title,
    location: c.location,
    email: c.email,
    phone: null,
    linkedinUrl: null,
    website: null,
    howMet: null,
    metContext: null,
    aiSummary: c.aiSummary,
    notes: c.notes,
    industry: c.industry,
    keyFacts: c.keyFacts,
    sharedInterests: null,
    relationshipScore: c.relationshipScore,
    priorityLevel: c.priorityLevel,
    tags: c.tags,
  };
}

/**
 * Adapts hybrid results to the KeywordSearchHit the ask-bar/graph UIs render.
 * matchedFields/explanation come from rankKeywordSearch run over just the
 * returned page (<= 80 rows) — cheap, and keeps the existing match-label UI.
 * Hybrid order is preserved; rankKeywordSearch only annotates.
 */
export function toKeywordHits(
  ranked: RankedContact[],
  query: string
): KeywordSearchHit[] {
  const annotations = new Map(
    rankKeywordSearch(ranked.map(toSearchable), query, ranked.length).map((h) => [h.id, h])
  );
  return ranked.map((c) => {
    const keyword = annotations.get(c.id);
    const hasLexicalArm = c.matchedArms.includes("fts") || c.matchedArms.includes("trigram");
    const hasSemanticArm = c.matchedArms.includes("semantic");
    return {
      id: c.id,
      fullName: c.fullName,
      preferredName: c.preferredName,
      company: c.company,
      title: c.title,
      relationshipScore: c.relationshipScore,
      priorityLevel: c.priorityLevel,
      tags: c.tags,
      score: c.relevance,
      matchedFields: keyword?.matchedFields ?? [],
      explanation: keyword?.explanation ?? "Related to your search",
      source: hasLexicalArm && hasSemanticArm ? "hybrid" : hasSemanticArm ? "semantic" : "keyword",
    };
  });
}
