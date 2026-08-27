import { completeJson, parseAiJson } from "@/lib/ai";
import type { RankedContact, SearchFilters } from "@/lib/hybrid-search";

export type ParsedQuery = {
  semanticQuery: string;
  filters: SearchFilters;
  expansionTerms: string[];
};

const UNDERSTAND_TIMEOUT_MS = 2500;
const MAX_FILTER_VALUES = 4;
const VALID_TIERS = new Set(["inner", "mid", "outer"]);

export function fallbackParsedQuery(question: string): ParsedQuery {
  return { semanticQuery: question, filters: {}, expansionTerms: [] };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("stage timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 1)
    .slice(0, MAX_FILTER_VALUES);
}

export function sanitizeParsedQuery(raw: unknown, question: string): ParsedQuery {
  const fallback = fallbackParsedQuery(question);
  if (!raw || typeof raw !== "object") return fallback;
  const obj = raw as Record<string, unknown>;
  const semanticQuery =
    typeof obj.semanticQuery === "string" && obj.semanticQuery.trim().length > 0
      ? obj.semanticQuery.trim()
      : question;

  const rawFilters = (obj.filters ?? {}) as Record<string, unknown>;
  const filters: SearchFilters = {};
  const companies = cleanStringArray(rawFilters.companies);
  if (companies.length) filters.companies = companies;
  const industries = cleanStringArray(rawFilters.industries);
  if (industries.length) filters.industries = industries;
  const schools = cleanStringArray(rawFilters.schools);
  if (schools.length) filters.schools = schools;
  const locations = cleanStringArray(rawFilters.locations);
  if (locations.length) filters.locations = locations;
  const tags = cleanStringArray(rawFilters.tags);
  if (tags.length) filters.tags = tags;
  const tiers = cleanStringArray(rawFilters.closenessTiers).filter((t) =>
    VALID_TIERS.has(t)
  ) as Array<"inner" | "mid" | "outer">;
  if (tiers.length) filters.closenessTiers = tiers;

  return {
    semanticQuery,
    filters,
    expansionTerms: cleanStringArray(obj.expansionTerms),
  };
}

const UNDERSTAND_SYSTEM = `You turn a question about someone's personal/professional network into a retrieval plan.
Extract only what the question explicitly states or strongly implies. Do not guess.
Filters narrow a database query over the user's contacts:
- companies, industries, schools, locations: substring matches (e.g. "fintech", "Stanford")
- tags: user-defined labels (e.g. "mentor", "investor")
- closenessTiers: subset of ["inner","mid","outer"] — ONLY when the question references closeness ("close friends" -> ["inner"], "acquaintances" -> ["outer"])
Self-references ("my school", "my company") can only be resolved from the user context provided; if it does not name one, OMIT that filter — never invent a value.
expansionTerms: up to 4 synonyms/adjacent terms that widen a keyword search (e.g. question about "AI" -> ["machine learning", "ML"]).
semanticQuery: the question rewritten as a dense retrieval query describing the ideal matching contact.
Return JSON: {"semanticQuery": string, "filters": {"companies"?: string[], "industries"?: string[], "schools"?: string[], "locations"?: string[], "tags"?: string[], "closenessTiers"?: string[]}, "expansionTerms": string[]}`;

/**
 * Accuracy-only stage: on any failure or timeout it returns the pass-through
 * fallback. It must never throw and never block the pipeline.
 */
export async function understandQuery(
  userId: string,
  question: string,
  userGoals: string[],
  completeFn: typeof completeJson = completeJson
): Promise<ParsedQuery> {
  const fallback = fallbackParsedQuery(typeof question === "string" ? question : "");
  if (typeof question !== "string" || question.trim().length < 8) return fallback;
  try {
    const goalsBlock = userGoals.length
      ? `User context — their active networking goals:\n${userGoals.map((g) => `- ${g}`).join("\n")}\n\n`
      : "";
    const content = await withTimeout(
      completeFn(userId, {
        operation: "chat.understand",
        speed: "fast",
        temperature: 0,
        maxOutputTokens: 512,
        system: UNDERSTAND_SYSTEM,
        user: `${goalsBlock}Question: ${question}`,
      }),
      UNDERSTAND_TIMEOUT_MS
    );
    return sanitizeParsedQuery(parseAiJson(content), question);
  } catch {
    return fallback;
  }
}

export const CANDIDATE_POOL = 60;
export const FINAL_CONTACT_COUNT = 12;
const RERANK_TIMEOUT_MS = 6000;
const RERANK_MIN_RELEVANCE = 3;
const RERANK_MIN_SURVIVORS = 3;

const RERANK_SYSTEM = `You score how relevant each candidate contact is to the user's question about their network.
10 = directly answers the question. 5 = plausibly useful. 0 = unrelated.
Judge from the card text only. Score every candidate you were given, using their exact ids.
Return JSON: {"scores": [{"id": string, "relevance": number}]}`;

function candidateCard(c: RankedContact): string {
  const summary = (c.aiSummary || c.notes || "").replace(/\s+/g, " ").slice(0, 160);
  return `[id=${c.id}] ${c.fullName} | ${c.title || "?"} @ ${c.company || "?"} | school=${c.school || "?"} | industry=${c.industry || "?"} | tier=${c.closenessTier || "?"} | tags=${c.tags.join(",") || "-"}${summary ? ` | ${summary}` : ""}`;
}

/**
 * Accuracy-only stage: scores candidates with a flash-tier model and keeps the
 * best FINAL_CONTACT_COUNT. On any failure it falls back to RRF order. Never throws.
 */
export async function rerankCandidates(
  userId: string,
  question: string,
  candidates: RankedContact[],
  completeFn: typeof completeJson = completeJson
): Promise<RankedContact[]> {
  if (candidates.length <= FINAL_CONTACT_COUNT) return candidates;
  try {
    const content = await withTimeout(
      completeFn(userId, {
        operation: "chat.rerank",
        speed: "fast",
        temperature: 0,
        maxOutputTokens: 2048,
        system: RERANK_SYSTEM,
        user: `Question: ${question}\n\nCandidates:\n${candidates.map(candidateCard).join("\n")}`,
      }),
      RERANK_TIMEOUT_MS
    );
    const parsed = parseAiJson<{ scores?: Array<{ id?: unknown; relevance?: unknown }> }>(content);
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const scored = (parsed.scores ?? [])
      .filter(
        (s): s is { id: string; relevance: number } =>
          typeof s.id === "string" && byId.has(s.id) && typeof s.relevance === "number"
      )
      .sort((a, b) => b.relevance - a.relevance);

    const kept = scored
      .filter((s) => s.relevance >= RERANK_MIN_RELEVANCE)
      .slice(0, FINAL_CONTACT_COUNT)
      .map((s) => byId.get(s.id)!);
    if (kept.length >= RERANK_MIN_SURVIVORS) return kept;

    // Threshold starved the set — trust the model's ordering for a smaller page.
    const ordered = scored.slice(0, 5).map((s) => byId.get(s.id)!);
    return ordered.length > 0 ? ordered : candidates.slice(0, FINAL_CONTACT_COUNT);
  } catch {
    return candidates.slice(0, FINAL_CONTACT_COUNT);
  }
}

export type BudgetedContact = {
  id: string;
  fullName: string;
  company: string | null;
  title: string | null;
  relationshipScore: number;
  aiSummary: string | null;
  notes: string | null;
  keyFacts: string[];
  recentMessages: string[];
  tags: string[];
  relevance: number;
};

/**
 * Per-contact context caps by rank tier, under one total character budget
 * (~12k tokens at 4 chars/token). Reranked survivors earned richer detail than
 * the old flat 400-chars-of-notes: rank buys depth.
 */
const CONTEXT_TIERS = [
  { upto: 4, notes: 1200, summary: 600, msgs: 8, msgChars: 320, facts: 8 },
  { upto: 8, notes: 600, summary: 400, msgs: 4, msgChars: 280, facts: 6 },
  { upto: Infinity, notes: 300, summary: 240, msgs: 2, msgChars: 240, facts: 4 },
] as const;
const TOTAL_CONTEXT_CHAR_BUDGET = 48000;

export function budgetContactsContext(
  contacts: RankedContact[],
  snippets: Map<string, { recentMessages: string[] }>
): BudgetedContact[] {
  const out: BudgetedContact[] = [];
  let spent = 0;
  for (let index = 0; index < contacts.length; index++) {
    const c = contacts[index];
    const tier = CONTEXT_TIERS.find((t) => index < t.upto)!;
    const notes = (c.notes || "").slice(0, tier.notes) || null;
    const aiSummary = (c.aiSummary || "").slice(0, tier.summary) || null;
    const keyFacts = c.keyFacts.slice(0, tier.facts);
    const recentMessages = (snippets.get(c.id)?.recentMessages ?? [])
      .slice(0, tier.msgs)
      .map((m) => m.slice(0, tier.msgChars));

    const cost =
      c.fullName.length + (c.company?.length ?? 0) + (c.title?.length ?? 0) +
      (notes?.length ?? 0) + (aiSummary?.length ?? 0) +
      keyFacts.join("").length + recentMessages.join("").length +
      c.tags.join("").length + 80; // formatting overhead
    // Budget exhaustion stops serialization entirely — a later, cheaper
    // contact must not be appended out of rank order once we've run dry.
    if (spent + cost > TOTAL_CONTEXT_CHAR_BUDGET && out.length > 0) break;
    spent += cost;

    out.push({
      id: c.id,
      fullName: c.fullName,
      company: c.company,
      title: c.title,
      relationshipScore: c.relationshipScore,
      aiSummary,
      notes,
      keyFacts,
      recentMessages,
      tags: c.tags,
      relevance: c.relevance,
    });
  }
  return out;
}
