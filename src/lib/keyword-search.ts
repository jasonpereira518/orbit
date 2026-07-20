export type SearchableContact = {
  id: string;
  fullName: string;
  preferredName?: string | null;
  company?: string | null;
  title?: string | null;
  location?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  website?: string | null;
  howMet?: string | null;
  metContext?: string | null;
  aiSummary?: string | null;
  notes?: string | null;
  industry?: string | null;
  keyFacts?: string[] | null;
  relationshipScore?: number | null;
  priorityLevel?: number | null;
  tags?: string[];
};

export type MatchedField =
  | "name"
  | "company"
  | "role"
  | "location"
  | "email"
  | "phone"
  | "linkedin"
  | "website"
  | "howMet"
  | "tags"
  | "summary"
  | "notes"
  | "industry"
  | "keyFacts";

export type SearchHitSource = "keyword" | "semantic" | "hybrid";

export type KeywordSearchHit = {
  id: string;
  fullName: string;
  preferredName: string | null;
  company: string | null;
  title: string | null;
  relationshipScore: number;
  priorityLevel: number;
  tags: string[];
  score: number;
  matchedFields: MatchedField[];
  explanation: string;
  source?: SearchHitSource;
};

const FIELD_WEIGHTS: Record<MatchedField, number> = {
  name: 12,
  company: 8,
  role: 7,
  tags: 6,
  email: 5,
  location: 4,
  howMet: 4,
  summary: 3.5,
  keyFacts: 3.5,
  notes: 3,
  industry: 3,
  phone: 2.5,
  linkedin: 2,
  website: 2,
};

const FIELD_LABELS: Record<MatchedField, string> = {
  name: "name",
  company: "company",
  role: "role",
  location: "location",
  email: "email",
  phone: "phone",
  linkedin: "LinkedIn",
  website: "website",
  howMet: "how you met",
  tags: "tags",
  summary: "summary",
  notes: "notes",
  industry: "industry",
  keyFacts: "key facts",
};

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokensOf(query: string) {
  return normalize(query)
    .split(/[^a-z0-9+#.]+/i)
    .filter((t) => t.length > 1);
}

function fieldValues(contact: SearchableContact): Record<MatchedField, string> {
  const name = [contact.fullName, contact.preferredName]
    .filter(Boolean)
    .join(" ");
  return {
    name,
    company: contact.company || "",
    role: contact.title || "",
    location: contact.location || "",
    email: contact.email || "",
    phone: contact.phone || "",
    linkedin: contact.linkedinUrl || "",
    website: contact.website || "",
    howMet: [contact.metContext, contact.howMet].filter(Boolean).join(" "),
    tags: (contact.tags || []).join(" "),
    summary: contact.aiSummary || "",
    notes: contact.notes || "",
    industry: contact.industry || "",
    keyFacts: (contact.keyFacts || []).join(" "),
  };
}

function scoreField(
  value: string,
  phrase: string,
  tokenList: string[]
): { points: number; matched: boolean } {
  if (!value.trim()) return { points: 0, matched: false };
  const hay = normalize(value);
  let points = 0;
  let matched = false;

  if (phrase && hay === phrase) {
    points += 4;
    matched = true;
  } else if (phrase && hay.includes(phrase)) {
    points += 2.2;
    matched = true;
  }

  for (const token of tokenList) {
    if (hay.includes(token)) {
      points += 1;
      matched = true;
    }
  }

  return { points, matched };
}

function explain(matchedFields: MatchedField[], score: number): string {
  if (matchedFields.length === 0) {
    return "Ranked by relationship strength";
  }
  const labels = matchedFields.slice(0, 3).map((f) => FIELD_LABELS[f]);
  const strength =
    score >= 0.75 ? "strong" : score >= 0.45 ? "good" : "partial";
  if (labels.length === 1) {
    return `${strength[0].toUpperCase()}${strength.slice(1)} match on ${labels[0]}`;
  }
  if (labels.length === 2) {
    return `${strength[0].toUpperCase()}${strength.slice(1)} match on ${labels[0]} and ${labels[1]}`;
  }
  return `${strength[0].toUpperCase()}${strength.slice(1)} match on ${labels[0]}, ${labels[1]}, and ${labels[2]}`;
}

/**
 * Local keyword ranking for dashboard command search.
 * Weights phrase/token hits by field, then blends priority + relationship strength.
 */
export function rankKeywordSearch(
  contacts: SearchableContact[],
  query: string,
  limit = 12
): KeywordSearchHit[] {
  const phrase = normalize(query);
  if (!phrase) return [];

  const tokenList = tokensOf(query);

  const hits = contacts
    .map((c) => {
      const fields = fieldValues(c);
      const matchedFields: MatchedField[] = [];
      let raw = 0;

      for (const key of Object.keys(FIELD_WEIGHTS) as MatchedField[]) {
        const { points, matched } = scoreField(fields[key], phrase, tokenList);
        if (!matched) continue;
        matchedFields.push(key);
        raw += points * FIELD_WEIGHTS[key];
      }

      if (raw <= 0) return null;

      // Blend relationship signals (inventory: priority + strength)
      raw += (c.relationshipScore || 0) * 1.2;
      raw += (c.priorityLevel || 0) * 2;

      // Normalize roughly into 0–1 for display
      const score = Math.min(1, raw / 40);

      matchedFields.sort(
        (a, b) => FIELD_WEIGHTS[b] - FIELD_WEIGHTS[a]
      );

      return {
        id: c.id,
        fullName: c.fullName,
        preferredName: c.preferredName || null,
        company: c.company || null,
        title: c.title || null,
        relationshipScore: c.relationshipScore || 2,
        priorityLevel: c.priorityLevel || 0,
        tags: c.tags || [],
        score,
        matchedFields,
        explanation: explain(matchedFields, score),
      } satisfies KeywordSearchHit;
    })
    .filter(Boolean) as KeywordSearchHit[];

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Merge keyword and semantic hits for dashboard hybrid search.
 */
export function mergeSearchHits(
  keywordHits: KeywordSearchHit[],
  semanticHits: Array<{
    contactId: string;
    similarity: number;
    contact: SearchableContact;
  }>,
  limit = 12
): KeywordSearchHit[] {
  const byId = new Map<string, KeywordSearchHit>();

  for (const hit of keywordHits) {
    byId.set(hit.id, { ...hit, source: hit.source ?? "keyword" });
  }

  for (const { contactId, similarity, contact } of semanticHits) {
    const semanticScore = Math.min(1, similarity);
    if (semanticScore < 0.3) continue;

    const existing = byId.get(contactId);
    if (existing) {
      existing.score = Math.min(1, existing.score * 0.4 + semanticScore * 0.6);
      existing.source = "hybrid";
      existing.explanation = `Keyword + semantic match (${Math.round(semanticScore * 100)}% similar)`;
      continue;
    }

    byId.set(contactId, {
      id: contactId,
      fullName: contact.fullName,
      preferredName: contact.preferredName || null,
      company: contact.company || null,
      title: contact.title || null,
      relationshipScore: contact.relationshipScore || 2,
      priorityLevel: contact.priorityLevel || 0,
      tags: contact.tags || [],
      score: semanticScore * 0.92,
      matchedFields: [],
      explanation: `Semantic match (${Math.round(semanticScore * 100)}% similar)`,
      source: "semantic",
    });
  }

  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export const MATCHED_FIELD_LABELS = FIELD_LABELS;
