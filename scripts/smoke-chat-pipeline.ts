/**
 * Structural checks that askNetwork runs the new pipeline: parallel
 * embed+understand, hybrid retrieval at CANDIDATE_POOL, rerank, budget.
 *
 * Retrieval itself lives in `src/lib/chat-context.ts`, not `src/actions/chat.ts` —
 * `prepareChatContext` is shared by the JSON action and the streaming route so the two
 * cannot drift, which is exactly what a copy of this pipeline inlined in chat.ts alone
 * would risk. The checks below scan both files rather than assuming one.
 *
 * Run: npx tsx scripts/smoke-chat-pipeline.ts
 */
import { readFileSync } from "node:fs";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const actionSrc = readFileSync("src/actions/chat.ts", "utf8");
  const contextSrc = readFileSync("src/lib/chat-context.ts", "utf8");
  const combined = `${actionSrc}\n${contextSrc}`;

  check("no semanticSearchContacts call", !combined.includes("semanticSearchContacts"));
  check("uses hybridSearchContacts", combined.includes("hybridSearchContacts"));
  check("embed and understand run in parallel", /Promise\.all\(\[\s*getQueryEmbedding/.test(combined));
  check("uses CANDIDATE_POOL", combined.includes("CANDIDATE_POOL"));
  check("reranks", combined.includes("rerankCandidates"));
  check("budgets context", combined.includes("budgetContactsContext"));
  check("hallucination filter intact", combined.includes("allowedContacts"));
  check("recruiter path intact", combined.includes("loadRecruitersForChat"));
  check("focus contact path intact", combined.includes("focusContactId"));
  // The retrieval pipeline must live in the shared module, not be re-inlined into the
  // action — that duplication is exactly what prepareChatContext exists to prevent.
  check("retrieval lives in chat-context.ts, not re-inlined in the action", !actionSrc.includes("hybridSearchContacts"));
  check("askNetwork delegates to prepareChatContext", actionSrc.includes("prepareChatContext"));

  // The action module must remain a valid "use server" file (async exports only).
  const exportsNonAsync = /export (function|const|let|var) /.test(actionSrc);
  check("no non-async exports in use-server file", !exportsNonAsync);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
