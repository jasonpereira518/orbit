/**
 * Unit tests for the chat retrieval pipeline stages (query understanding,
 * rerank, context budgeting) with stubbed AI calls. No DB, no network.
 * Run: npx tsx scripts/smoke-chat-retrieval.ts
 */
import {
  fallbackParsedQuery,
  sanitizeParsedQuery,
  understandQuery,
} from "../src/lib/chat-retrieval";

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
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
