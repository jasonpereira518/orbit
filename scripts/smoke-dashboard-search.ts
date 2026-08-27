/**
 * Verifies the ask-bar search adapter: RankedContact -> KeywordSearchHit mapping
 * and the lexical-only decision for short queries. No DB, no network.
 * Run: npx tsx scripts/smoke-dashboard-search.ts
 */
import { readFileSync } from "node:fs";
import { shouldUseSemanticArm, toKeywordHits } from "../src/actions/search-adapter";
import type { RankedContact } from "../src/lib/hybrid-search";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const ranked: RankedContact = {
  id: "c1", fullName: "Ada Lovelace", preferredName: null, company: "Analytical Engines",
  school: null, title: "Engineer", location: null, email: null, industry: null,
  notes: null, aiSummary: null, keyFacts: [], relationshipScore: 7, priorityLevel: 2,
  closenessTier: "inner", tags: ["mentor"], rrfScore: 0.03, relevance: 1,
  matchedArms: ["fts", "semantic"], filterMatched: true,
};

async function main() {
  check("1 token -> lexical only", shouldUseSemanticArm("ada") === false);
  check("2 tokens -> lexical only", shouldUseSemanticArm("ada lovelace") === false);
  check("3 tokens -> semantic", shouldUseSemanticArm("who knows ada") === true);

  const hits = toKeywordHits([ranked], "ada");
  check("maps id/name", hits[0].id === "c1" && hits[0].fullName === "Ada Lovelace");
  check("keyword+semantic arms -> hybrid source", hits[0].source === "hybrid");
  check("score carried from relevance", hits[0].score > 0);
  check("keyword-derived matchedFields present", hits[0].matchedFields.includes("name"));

  const semanticOnly = toKeywordHits([{ ...ranked, matchedArms: ["semantic"] }], "zzz");
  check("semantic-only source", semanticOnly[0].source === "semantic");

  const src = readFileSync("src/actions/search.ts", "utf8");
  // The rewrite delegates all data access to hybridSearchContacts — the action
  // file itself should no longer touch tables or embeddings at all.
  check("full-table loadContacts removed", !src.includes("loadContacts") && !src.includes("findMany"));
  check("unbounded embedding fallback removed", !src.includes("contactEmbeddings") && !src.includes("cosineSimilarity"));
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
