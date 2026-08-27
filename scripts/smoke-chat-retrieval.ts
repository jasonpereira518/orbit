/**
 * Unit tests for the chat retrieval pipeline stages (query understanding,
 * rerank, context budgeting) with stubbed AI calls. No DB, no network.
 * Run: npx tsx scripts/smoke-chat-retrieval.ts
 */
import {
  budgetContactsContext,
  fallbackParsedQuery,
  FINAL_CONTACT_COUNT,
  rerankCandidates,
  sanitizeParsedQuery,
  understandQuery,
} from "../src/lib/chat-retrieval";
import type { RankedContact } from "../src/lib/hybrid-search";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const fb = fallbackParsedQuery("who knows rust?");
  check("fallback echoes question", fb.semanticQuery === "who knows rust?");
  check("fallback has no filters", Object.keys(fb.filters).length === 0);

  const sane = sanitizeParsedQuery(
    {
      semanticQuery: "engineers at fintech companies",
      filters: {
        industries: ["fintech"],
        companies: ["  Stripe  ", "", "a", "b", "c", "d"], // 6 entries incl junk
        closenessTiers: ["inner", "bogus"],
      },
      expansionTerms: ["finance", "payments", 42],
    },
    "who at a fintech?"
  );
  check("keeps semantic query", sane.semanticQuery === "engineers at fintech companies");
  check("trims + caps companies at 4", sane.filters.companies!.length <= 4 && sane.filters.companies![0] === "Stripe");
  check("drops invalid tier", sane.filters.closenessTiers!.length === 1 && sane.filters.closenessTiers![0] === "inner");
  check("drops non-string expansion terms", sane.expansionTerms.every((t) => typeof t === "string"));

  const junk = sanitizeParsedQuery({ nonsense: true }, "raw question");
  check("garbage parse degrades to fallback", junk.semanticQuery === "raw question");

  // understandQuery with a stub that returns valid JSON
  const okStub = (async (_userId: string, _input: unknown) =>
    JSON.stringify({
      semanticQuery: "people who invest",
      filters: { tags: ["investor"] },
      expansionTerms: ["vc"],
    })) as never;
  const parsed = await understandQuery("u1", "which of my contacts invest?", [], okStub);
  check("stub parse flows through", parsed.filters.tags?.[0] === "investor");

  // understandQuery with a stub that throws -> fallback, never an exception
  const failStub = (async () => {
    throw new Error("provider down");
  }) as never;
  const degraded = await understandQuery("u1", "which of my contacts invest?", [], failStub);
  check("stage failure degrades to fallback", degraded.semanticQuery === "which of my contacts invest?");

  // understandQuery with non-string question (upstream `any` leakage) -> never throws
  const nonString = await understandQuery("u1", 42 as never, [], failStub);
  check("non-string question never throws", nonString.semanticQuery === "");

  // ---- rerank ----
  const mkCandidate = (id: string, name: string): RankedContact => ({
    id, fullName: name, preferredName: null, company: null, school: null,
    title: null, location: null, email: null, industry: null, notes: null,
    aiSummary: null, keyFacts: [], relationshipScore: 5, priorityLevel: 1,
    closenessTier: null, tags: [], rrfScore: 0.02, relevance: 0.9,
    matchedArms: ["fts"], filterMatched: true,
  });
  const pool = Array.from({ length: 20 }, (_, i) => mkCandidate(`c${i}`, `Person ${i}`));

  const rerankStub = (async (_u: string, _input: unknown) =>
    JSON.stringify({
      scores: [
        { id: "c7", relevance: 9 },
        { id: "c3", relevance: 8 },
        { id: "c19", relevance: 7 },
        { id: "c0", relevance: 2 },          // below threshold
        { id: "hallucinated", relevance: 10 }, // not a candidate
      ],
    })) as never;
  const reranked = await rerankCandidates("u1", "q", pool, rerankStub);
  check("rerank orders by relevance", reranked[0].id === "c7" && reranked[1].id === "c3");
  check("rerank drops below-threshold", !reranked.some((c) => c.id === "c0"));
  check("rerank drops hallucinated ids", !reranked.some((c) => c.id === "hallucinated"));
  check("rerank caps at FINAL_CONTACT_COUNT", reranked.length <= FINAL_CONTACT_COUNT);

  const rerankFail = (async () => { throw new Error("down"); }) as never;
  const fallbackOrder = await rerankCandidates("u1", "q", pool, rerankFail);
  check("rerank failure falls back to RRF order", fallbackOrder.length === FINAL_CONTACT_COUNT && fallbackOrder[0].id === "c0");

  const small = await rerankCandidates("u1", "q", pool.slice(0, 5), rerankFail);
  check("small pool skips rerank", small.length === 5);

  // threshold starvation: only 2 candidates clear RERANK_MIN_RELEVANCE ->
  // trust the model's ordering for a smaller (top-5) page instead of RRF fallback.
  const starvedScores = pool.map((c) => ({
    id: c.id,
    relevance: c.id === "c7" ? 9 : c.id === "c3" ? 8 : 1,
  }));
  const starvedStub = (async (_u: string, _input: unknown) =>
    JSON.stringify({ scores: starvedScores })) as never;
  const starved = await rerankCandidates("u1", "q", pool, starvedStub);
  check(
    "rerank threshold starvation falls back to top-5 by score",
    starved.length === 5 && starved[0].id === "c7" && starved[1].id === "c3"
  );

  // empty scored list from the model -> nothing clears the threshold, RRF fallback.
  const emptyStub = (async (_u: string, _input: unknown) =>
    JSON.stringify({ scores: [] })) as never;
  const emptyScored = await rerankCandidates("u1", "q", pool, emptyStub);
  check(
    "rerank empty scores falls back to RRF order",
    emptyScored.length === FINAL_CONTACT_COUNT && emptyScored[0].id === "c0"
  );

  // ---- budget ----
  const longNotes = "x".repeat(5000);
  const budgetPool = Array.from({ length: 12 }, (_, i) => ({
    ...mkCandidate(`b${i}`, `Person ${i}`),
    notes: longNotes,
    keyFacts: Array.from({ length: 12 }, (_, j) => `fact ${j}`),
  }));
  const snippets = new Map(
    budgetPool.map((c) => [
      c.id,
      { recentMessages: Array.from({ length: 10 }, (_, j) => "m".repeat(400) + j) },
    ])
  );
  const budgeted = budgetContactsContext(budgetPool, snippets);
  check("budget keeps order", budgeted[0].id === "b0");
  check("top tier gets more notes than tail", budgeted[0].notes!.length > budgeted[11].notes!.length);
  check("messages trimmed per tier", budgeted[0].recentMessages.length <= 8 && budgeted[11].recentMessages.length <= 2);
  const totalChars = budgeted.reduce(
    (n, c) =>
      n + (c.notes?.length ?? 0) + (c.aiSummary?.length ?? 0) +
      c.recentMessages.join("").length + c.keyFacts.join("").length,
    0
  );
  check("total context under budget", totalChars <= 48000);

  // budget must STOP once exhausted, not skip an oversized contact and keep
  // appending cheaper ones after it (that would violate rank-order serialization).
  const stopPool = [
    mkCandidate("s0", "Person 0"),
    mkCandidate("s1", "Person 1"),
    { ...mkCandidate("s2", "Person 2"), company: "x".repeat(60000) },
    mkCandidate("s3", "Person 3"),
    mkCandidate("s4", "Person 4"),
  ];
  const stopSnippets = new Map(stopPool.map((c) => [c.id, { recentMessages: [] }]));
  const stopped = budgetContactsContext(stopPool, stopSnippets);
  check(
    "budget stops at first oversized contact instead of skip-and-continue",
    stopped.length === 2 && stopped[0].id === "s0" && stopped[1].id === "s1"
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
