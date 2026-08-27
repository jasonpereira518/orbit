/**
 * Structural checks that askNetwork runs the new pipeline: parallel
 * embed+understand, hybrid retrieval at CANDIDATE_POOL, rerank, budget.
 * Run: npx tsx scripts/smoke-chat-pipeline.ts
 */
import { readFileSync } from "node:fs";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const src = readFileSync("src/actions/chat.ts", "utf8");
  check("no semanticSearchContacts call", !src.includes("semanticSearchContacts"));
  check("uses hybridSearchContacts", src.includes("hybridSearchContacts"));
  check("embed and understand run in parallel", /Promise\.all\(\[\s*getQueryEmbedding/.test(src));
  check("uses CANDIDATE_POOL", src.includes("CANDIDATE_POOL"));
  check("reranks", src.includes("rerankCandidates"));
  check("budgets context", src.includes("budgetContactsContext"));
  check("hallucination filter intact", src.includes("allowedContacts"));
  check("recruiter path intact", src.includes("loadRecruitersForChat"));
  check("focus contact path intact", src.includes("focusContactId"));

  // The action module must remain a valid "use server" file (async exports only).
  const exportsNonAsync = /export (function|const|let|var) /.test(src);
  check("no non-async exports in use-server file", !exportsNonAsync);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
