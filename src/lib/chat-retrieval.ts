import { completeJson, parseAiJson } from "@/lib/ai";
import { RERANK_TUNING, rerankQuestion } from "@/lib/decisions/catalog";
import { askPerItem, type Decider } from "@/lib/decisions/jev";
import type { RankedContact, SearchFilters } from "@/lib/hybrid-search";
import { pickNoteWindow } from "@/lib/note-window";

export type ParsedQuery = {
  semanticQuery: string;
  filters: SearchFilters;
  expansionTerms: string[];
  /**
   * How the question should be routed, from the same call — the fallback router when the
   * account has no decision model (decisions/chat-route.ts). Absent when the parser did not
   * answer, or answered without it; the keyword rules route then.
   */
  intent?: { needsResearch: boolean; attention: boolean; recruiters: boolean };
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

  const rawIntent = (obj.intent ?? null) as Record<string, unknown> | null;
  const intent =
    rawIntent &&
    typeof rawIntent.needs_research === "boolean" &&
    typeof rawIntent.attention === "boolean" &&
    typeof rawIntent.recruiters === "boolean"
      ? { needsResearch: rawIntent.needs_research, attention: rawIntent.attention, recruiters: rawIntent.recruiters }
      : undefined;

  return {
    semanticQuery,
    filters,
    expansionTerms: cleanStringArray(obj.expansionTerms),
    ...(intent ? { intent } : {}),
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
intent — how to answer it:
- needs_research: true ONLY when answering needs what was said or written in notes or conversations, an introduction or path to someone, events in a specific past period, or refers back to people from earlier turns. False for "who do I know at/in/with X", "who fits this description", and profile questions.
- attention: true ONLY when asking which people across the network to reconnect or follow up with, or who has gone quiet or is overdue. False for one named person, drafting a message, or "who should I ask about X".
- recruiters: true ONLY when asking for recruiters, headhunters or talent-acquisition people themselves.
Return JSON: {"semanticQuery": string, "filters": {"companies"?: string[], "industries"?: string[], "schools"?: string[], "locations"?: string[], "tags"?: string[], "closenessTiers"?: string[]}, "expansionTerms": string[], "intent": {"needs_research": boolean, "attention": boolean, "recruiters": boolean}}`;

/**
 * Accuracy-only stage: on any failure or timeout it returns the pass-through
 * fallback. It must never throw and never block the pipeline.
 *
 * Spec erratum: the spec says self-references ("my school", "my company")
 * resolve against the user's profile, but userSettings carries no
 * school/company profile fields to resolve against — only active networking
 * goals are available as user context here. Unresolvable self-references are
 * therefore deliberately left unfiltered (see UNDERSTAND_SYSTEM) rather than
 * guessing a value.
 * @param userGoals - the user's active networking goals, used as context.
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
// The WHOLE rank step, whichever engines it tries — keeps the worst-case pipeline inside the
// ~10s budget. Jev takes its share first (RERANK_TUNING.timeoutMs); the LLM rerank gets what
// remains, not a fresh 4s of its own (the two used to stack to 5.5s); search order after that.
const RANK_BUDGET_MS = 4000;
/** An LLM rerank with less time than this cannot finish; go straight to search order. */
const MIN_LLM_RERANK_MS = 500;
const RERANK_MIN_RELEVANCE = 3;
const RERANK_MIN_SURVIVORS = 3;

const RERANK_SYSTEM = `You score how relevant each candidate contact is to the user's question about their network.
10 = directly answers the question. 5 = plausibly useful. 0 = unrelated.
Judge from the card text only. Score every candidate you were given, using their exact ids.
Candidates marked matches_filters=no did not satisfy the user's explicit filters and were included only as backup — prefer matches_filters=yes candidates when relevance is comparable.
Return JSON: {"scores": [{"id": string, "relevance": number}]}`;

function candidateCard(c: RankedContact): string {
  const summary = (c.aiSummary || c.notes || "").replace(/\s+/g, " ").slice(0, 160);
  return `[id=${c.id}] ${c.fullName} | ${c.title || "?"} @ ${c.company || "?"} | school=${c.school || "?"} | industry=${c.industry || "?"} | tier=${c.closenessTier || "?"} | tags=${c.tags.join(",") || "-"}${summary ? ` | ${summary}` : ""} | matches_filters=${c.filterMatched ? "yes" : "no"}`;
}

/**
 * The card the decision model reads: the same facts as `candidateCard`, as named fields,
 * minus the id (nothing to copy back — answers come keyed) and minus the filter flag, which
 * `rerankWithDecider` applies in code rather than asking the model to weigh.
 */
function decisionCard(c: RankedContact) {
  const summary = (c.aiSummary || c.notes || "").replace(/\s+/g, " ").slice(0, 160);
  return {
    name: c.fullName,
    title: c.title,
    company: c.company,
    school: c.school,
    industry: c.industry,
    closeness_tier: c.closenessTier,
    tags: c.tags.length ? c.tags : null,
    summary: summary || null,
  };
}

/**
 * The rerank on the decision model (TypeSafe's Jev): one ordered-score question per
 * candidate, answered in ~100–500ms for a fraction of the flash model's cost — the LLM spent
 * most of its tokens WRITING 0–10 scores, and Jev's output is free. Scores are calibrated
 * and keyed, so there are no mistyped ids to drop and no 2048-token truncation.
 *
 * All-or-nothing: if any chunk of candidates goes unanswered it returns null and the caller
 * runs the LLM rerank, because ranking answered candidates against unanswered ones would
 * rank by who happened to be in the call that failed.
 */
export async function rerankWithDecider(
  decider: Decider,
  question: string,
  candidates: RankedContact[],
  semanticQuery?: string | null,
  timeoutMs: number = RERANK_TUNING.timeoutMs
): Promise<RankedContact[] | null> {
  const lookingFor =
    semanticQuery?.trim() && semanticQuery.trim() !== question.trim() ? semanticQuery.trim() : null;
  const answers = await askPerItem(
    decider,
    {
      operation: "chat.rerank.decide",
      items: candidates,
      chunkSize: RERANK_TUNING.chunkSize,
      // Every chunk at once: this sits on the critical path of a question.
      concurrency: Math.ceil(candidates.length / RERANK_TUNING.chunkSize),
      state: (chunk) => ({
        question,
        ...(lookingFor ? { looking_for: lookingFor } : {}),
        candidates: Object.fromEntries(chunk.map(({ key, item }) => [key, decisionCard(item)])),
      }),
      question: rerankQuestion,
    },
    { timeoutMs }
  );
  if (answers.some((a) => a === null)) return null;

  // A stable sort, so candidates Jev scores alike keep their search (RRF) order.
  const scored = candidates
    .map((c, i) => {
      const relevance = answers[i]!.normalized;
      return { c, relevance, rank: relevance + (c.filterMatched ? RERANK_TUNING.filterBonus : 0) };
    })
    .sort((a, b) => b.rank - a.rank);

  const kept = scored
    .filter((s) => s.relevance >= RERANK_TUNING.keepMin)
    .slice(0, FINAL_CONTACT_COUNT)
    .map((s) => s.c);
  if (kept.length >= RERANK_MIN_SURVIVORS) return kept;
  // Threshold starved the set — the same smaller page the LLM path returns.
  return scored.slice(0, 5).map((s) => s.c);
}

/** Which engine ranked: Jev, the flash-model rerank, or plain search order (no rerank ran). */
export type RankEngine = "jev" | "llm" | "search";

/**
 * Accuracy-only stage: scores candidates and keeps the best FINAL_CONTACT_COUNT — on the
 * decision model when the account has one, else (or when it gives no answer) on a
 * flash-tier model. On any failure it falls back to RRF order. Never throws.
 *
 * `engine` is null when there was nothing to rank (the pool already fits).
 */
export async function rerankCandidatesWithEngine(
  userId: string,
  question: string,
  candidates: RankedContact[],
  completeFn: typeof completeJson = completeJson,
  /**
   * `understandQuery`'s rewrite of the question as a description of the ideal matching
   * contact.
   *
   * This is where it belongs. It was computed on every question and read by nothing — the
   * embedding and the keyword search were both handed the raw question — so the half of
   * the parser that writes it was paid for and thrown away. It cannot feed the embedding
   * without serializing the parse ahead of it, which would put the parse's 2.5s timeout on
   * the critical path of every question. The rerank already runs after the parse, so
   * passing it here costs nothing and is exactly the judgement it describes.
   */
  semanticQuery?: string | null,
  /** The account's decision model (`openDecider`), or null for the LLM rerank. */
  decider: Decider | null = null
): Promise<{ contacts: RankedContact[]; engine: RankEngine | null }> {
  if (candidates.length <= FINAL_CONTACT_COUNT) return { contacts: candidates, engine: null };
  const searchOrder = () => ({ contacts: candidates.slice(0, FINAL_CONTACT_COUNT), engine: "search" as const });
  const deadline = Date.now() + RANK_BUDGET_MS;
  if (decider) {
    const decided = await rerankWithDecider(
      decider,
      question,
      candidates,
      semanticQuery,
      Math.min(RERANK_TUNING.timeoutMs, RANK_BUDGET_MS)
    ).catch(() => null);
    if (decided) return { contacts: decided, engine: "jev" };
  }
  const remaining = deadline - Date.now();
  if (remaining < MIN_LLM_RERANK_MS) return searchOrder();
  try {
    const content = await withTimeout(
      completeFn(userId, {
        operation: "chat.rerank",
        temperature: 0,
        // Cancels the request itself at the deadline, instead of leaving it to bill on.
        signal: AbortSignal.timeout(remaining),
        maxOutputTokens: 2048,
        system: RERANK_SYSTEM,
        user: [
          `Question: ${question}`,
          // Only when it says something the question does not already say.
          semanticQuery?.trim() && semanticQuery.trim() !== question.trim()
            ? `Looking for: ${semanticQuery.trim()}`
            : "",
          "",
          `Candidates:\n${candidates.map(candidateCard).join("\n")}`,
        ]
          .filter(Boolean)
          .join("\n"),
      }),
      remaining
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
    if (kept.length >= RERANK_MIN_SURVIVORS) return { contacts: kept, engine: "llm" };

    // Threshold starved the set — trust the model's ordering for a smaller page.
    const ordered = scored.slice(0, 5).map((s) => byId.get(s.id)!);
    return ordered.length > 0 ? { contacts: ordered, engine: "llm" } : searchOrder();
  } catch {
    return searchOrder();
  }
}

/** `rerankCandidatesWithEngine`, for callers that only want the contacts. */
export async function rerankCandidates(
  ...args: Parameters<typeof rerankCandidatesWithEngine>
): Promise<RankedContact[]> {
  return (await rerankCandidatesWithEngine(...args)).contacts;
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
  timeline: string[];
  tags: string[];
  relevance: number;
  /** Compact career summary — "Ramp, ex-Stripe · MIT". Null when no profile is stored. */
  career: string | null;
};

/**
 * Per-contact context caps by rank tier, under one total character budget
 * (~12k tokens at 4 chars/token). Reranked survivors earned richer detail than
 * the old flat 400-chars-of-notes: rank buys depth.
 */
// `entries` counts timeline lines, which used to be LinkedIn messages only and were
// therefore empty for most contacts. Now that every interaction type reaches the prompt,
// almost every contact has some — so the counts came down. The budget below binds far more
// often than it used to, and a contact serialized with eight timeline lines is a contact
// somebody further down the ranking does not get serialized at all.
//
// `notes` is a WINDOW, not a prefix: the tier says how many characters of the note the model
// gets, and `pickNoteWindow` decides which ones. A contact retrieved because of something
// written 3,000 characters into their note used to arrive with the first 1,200 and nothing
// to say about the match.
const CONTEXT_TIERS = [
  { upto: 4, notes: 1200, summary: 600, entries: 6, entryChars: 240, facts: 8 },
  { upto: 8, notes: 600, summary: 400, entries: 4, entryChars: 200, facts: 6 },
  { upto: Infinity, notes: 300, summary: 240, entries: 2, entryChars: 160, facts: 4 },
] as const;
const TOTAL_CONTEXT_CHAR_BUDGET = 48000;

export function budgetContactsContext(
  contacts: RankedContact[],
  snippets: Map<string, { timeline: string[] }>,
  careerLines: Map<string, string> = new Map(),
  /**
   * The question, so a trimmed note keeps the part that answers it.
   *
   * Optional, and an empty string reproduces the old head-slice exactly — the eval harness
   * and a couple of smoke scripts call this without a query and should not change behaviour.
   * See `pickNoteWindow` (@/lib/note-window) for why the head was the wrong 1,200 characters.
   */
  query: string = ""
): BudgetedContact[] {
  const out: BudgetedContact[] = [];
  let spent = 0;
  for (let index = 0; index < contacts.length; index++) {
    const c = contacts[index];
    const tier = CONTEXT_TIERS.find((t) => index < t.upto)!;
    const notes = pickNoteWindow(c.notes, query, tier.notes).text || null;
    const aiSummary = (c.aiSummary || "").slice(0, tier.summary) || null;
    const keyFacts = c.keyFacts.slice(0, tier.facts);
    const timeline = (snippets.get(c.id)?.timeline ?? [])
      .slice(0, tier.entries)
      .map((m) => m.slice(0, tier.entryChars));
    const career = careerLines.get(c.id) ?? null;

    const cost =
      c.fullName.length + (c.company?.length ?? 0) + (c.title?.length ?? 0) +
      (notes?.length ?? 0) + (aiSummary?.length ?? 0) + (career?.length ?? 0) +
      keyFacts.join("").length + timeline.join("").length +
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
      timeline,
      tags: c.tags,
      relevance: c.relevance,
      career,
    });
  }
  return out;
}
