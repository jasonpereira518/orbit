import type { ChatContext } from "@/lib/chat-context";

/**
 * The retrieval trace as it crosses to the browser.
 *
 * A separate, explicitly listed shape rather than shipping `ChatContext.trace` directly:
 * the context holds whole contact rows — notes, key facts, summaries — and a diagnostics
 * panel needs the scores, not the contents. Naming every field here is what keeps a future
 * addition to `RankedContact` from silently widening what a chat response carries.
 *
 * Only ever built for a testing account. See `buildChatDiagnostics`' one caller.
 */
export type ChatDiagnostics = {
  stages: Array<{ name: string; ms: number }>;
  totalMs: number;
  embedded: boolean;
  parsed: {
    semanticQuery: string;
    filters: Array<{ key: string; value: string }>;
    expansionTerms: string[];
  };
  candidateCount: number;
  finalCount: number;
  rerank: {
    ran: boolean;
    outcome: "skipped" | "kept" | "starved" | "fallback";
    scored: number;
  };
  constants: { candidatePool: number; finalContactCount: number };
  /** One row per contact that survived into the model's context. */
  contacts: Array<{
    id: string;
    fullName: string;
    company: string | null;
    /** Which search arms matched: fts, trigram, semantic. */
    matchedArms: string[];
    /** Reciprocal-rank-fusion score from the hybrid search. */
    rrfScore: number;
    /** Normalized relevance after the rerank. */
    relevance: number;
    /** False for rows the recall guard pulled in despite not matching the filters. */
    filterMatched: boolean;
    /** The model's 0-10 score, when the reranker ran. */
    rerankScore: number | null;
  }>;
};

/** Filters arrive as an open-ended object; flatten to printable pairs for the panel. */
function flattenFilters(
  filters: Record<string, unknown>
): Array<{ key: string; value: string }> {
  return Object.entries(filters)
    .filter(([, value]) => value != null && (!Array.isArray(value) || value.length > 0))
    .map(([key, value]) => ({
      key,
      value: Array.isArray(value) ? value.join(", ") : String(value),
    }));
}

export function buildChatDiagnostics(ctx: ChatContext): ChatDiagnostics {
  const { trace } = ctx;
  const rerankById = new Map(trace.rerank.scores.map((s) => [s.id, s.relevance]));

  return {
    stages: trace.stages,
    totalMs: trace.stages.reduce((sum, s) => sum + s.ms, 0),
    embedded: trace.embedded,
    parsed: {
      semanticQuery: trace.parsed.semanticQuery,
      filters: flattenFilters(trace.parsed.filters),
      expansionTerms: trace.parsed.expansionTerms,
    },
    candidateCount: trace.candidateCount,
    finalCount: trace.finalCount,
    rerank: {
      ran: trace.rerank.ran,
      outcome: trace.rerank.outcome,
      scored: trace.rerank.scores.length,
    },
    constants: trace.constants,
    contacts: ctx.retrieved.map((c) => ({
      id: c.id,
      fullName: c.fullName,
      company: c.company,
      matchedArms: c.matchedArms,
      rrfScore: c.rrfScore,
      relevance: c.relevance,
      filterMatched: c.filterMatched,
      rerankScore: rerankById.get(c.id) ?? null,
    })),
  };
}
