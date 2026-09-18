/**
 * When a chat answer was grounded in keywords only, and when that is worth saying.
 * Run: npx tsx scripts/smoke-chat-search-notice.ts
 */
import { KEYWORD_ONLY_SEARCH_NOTICE, embeddingFailureNotice } from "../src/lib/chat-search-notice";
import { MISSING_AI_API_KEY_MESSAGE } from "../src/lib/errors";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

check("no embedding key is a configuration, not news", embeddingFailureNotice(new Error("No Gemini API key configured for embeddings. Add your own key in Settings.")) === null);
check("Anthropic-only is silent", embeddingFailureNotice(new Error("Anthropic has no embeddings API. Add an OpenAI or Gemini key.")) === null);
check("Orbit's own no-key message is silent", embeddingFailureNotice(new Error(MISSING_AI_API_KEY_MESSAGE)) === null);
check("a timeout says keywords only", embeddingFailureNotice(new Error("Gemini timed out — try again, or ask something shorter")) === KEYWORD_ONLY_SEARCH_NOTICE);
check("a network failure says keywords only", embeddingFailureNotice(new TypeError("fetch failed")) === KEYWORD_ONLY_SEARCH_NOTICE);
check("a thrown string says keywords only", embeddingFailureNotice("boom") === KEYWORD_ONLY_SEARCH_NOTICE);
check("house voice", !KEYWORD_ONLY_SEARCH_NOTICE.includes("'") && !KEYWORD_ONLY_SEARCH_NOTICE.endsWith(".") && KEYWORD_ONLY_SEARCH_NOTICE.split(" — ").length === 2);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
