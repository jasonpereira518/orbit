import { completeJson, parseAiJson } from "@/lib/ai";
import type { SearchFilters } from "@/lib/hybrid-search";

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
  const fallback = fallbackParsedQuery(question);
  if (question.trim().length < 8) return fallback;
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
