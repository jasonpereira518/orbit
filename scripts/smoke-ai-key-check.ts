/**
 * Pins the save-time BYOK key check (audit A9): a refused key is refused with the
 * provider's name, a network failure or timeout still saves (a provider outage must not
 * stop someone saving a good key), and the check never waits longer than its budget.
 *
 * Pure: the provider calls are injected. Run: npx tsx scripts/smoke-ai-key-check.ts
 */
import {
  checkAiKey,
  checkDecisionKey,
  isKeyRejection,
  keyCheckOutcome,
  KEY_PROBES,
  type KeyProbe,
} from "../src/lib/ai-key-check";
import type { AiProvider } from "../src/lib/ai-providers";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const withStatus = (message: string, status: number) => Object.assign(new Error(message), { status });
const all = (probe: KeyProbe): Record<AiProvider, KeyProbe> => ({ gemini: probe, openai: probe, anthropic: probe });

async function main() {
  console.log("Verdicts");
  let seen = "";
  check("a probe that resolves → accepted",
    (await checkAiKey("openai", "sk-good-key", { probes: all(async (key) => { seen = key; }) })) === "accepted");
  check("…and the probe received the key", seen === "sk-good-key");
  check("401 → rejected", (await checkAiKey("openai", "sk-refused", { probes: all(async () => { throw withStatus("401 Incorrect API key provided", 401); }) })) === "rejected");
  check("403 → rejected", (await checkAiKey("anthropic", "sk-ant-refused", { probes: all(async () => { throw withStatus("403 permission_error", 403); }) })) === "rejected");
  check("Gemini's 400 'API key not valid' → rejected",
    (await checkAiKey("gemini", "AIza-not-valid", { probes: all(async () => { throw withStatus("API key not valid. Please pass a valid API key.", 400); }) })) === "rejected");
  check("a 500 → unverified", (await checkAiKey("gemini", "AIza-server-error", { probes: all(async () => { throw withStatus("500 internal", 500); }) })) === "unverified");
  check("a network error → unverified", (await checkAiKey("openai", "sk-network", { probes: all(async () => { throw new TypeError("fetch failed"); }) })) === "unverified");
  let probed = false;
  const never = all(async () => {
    probed = true;
  });
  check("a key with a stray character (a pasted ellipsis) → malformed, not unverified",
    (await checkAiKey("openai", "sk-abc\u2026def", { probes: never })) === "malformed");
  check("…and so does a non-breaking space, or a key too short to be one",
    (await checkAiKey("gemini", "AIza\u00a0abc123", { probes: never })) === "malformed" &&
      (await checkAiKey("gemini", "k", { probes: never })) === "malformed");
  check("…without a probe being made", !probed);
  check("the TypeSafe key gets the same check", (await checkDecisionKey("\u2026", { probe: async () => {} })) === "malformed");

  const started = Date.now();
  const hung = await checkAiKey("anthropic", "sk-ant-hung", { timeoutMs: 50, probes: all(() => new Promise<void>(() => {})) });
  check("a probe that never answers → unverified", hung === "unverified");
  check("…within the budget, not the probe's pace", Date.now() - started < 1000, `${Date.now() - started}ms`);
  let aborted = false;
  await checkAiKey("gemini", "AIza-aborted", {
    timeoutMs: 50,
    probes: all((_key, signal) => new Promise<void>((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }))),
  });
  check("the timeout aborts the probe's request", aborted);

  console.log("\nisKeyRejection");
  check("a status-less refused body counts", isKeyRejection(new Error("invalid x-api-key")));
  check("a rate limit does not", !isKeyRejection(withStatus("429 rate limit", 429)));

  console.log("\nWhat the person reads");
  const rejected = keyCheckOutcome("rejected", "gemini");
  check("rejected → not saved, with the provider's name",
    rejected.save === false && rejected.error === "Google Gemini didn’t accept that key — check it and try again", JSON.stringify(rejected));
  const unverified = keyCheckOutcome("unverified", "openai");
  check("unverified → saved with a note", unverified.save === true && unverified.note === "Saved — OpenAI didn’t answer, so the key isn’t checked yet", JSON.stringify(unverified));
  const malformed = keyCheckOutcome("malformed", "typesafe");
  check("malformed → not saved, and told to copy it again",
    malformed.save === false && malformed.error === "That key has a character API keys don’t contain — copy it again from TypeSafe", JSON.stringify(malformed));
  const accepted = keyCheckOutcome("accepted", "anthropic");
  check("accepted → saved, no note", accepted.save === true && accepted.note === null);
  const copy = [rejected.save ? "" : rejected.error, unverified.save ? unverified.note ?? "" : ""];
  check("house voice: curly apostrophes, no trailing period",
    copy.every((m) => !m.includes("'") && !m.endsWith(".")));

  console.log("\nEvery provider has a real probe");
  check("gemini, openai and anthropic", ["gemini", "openai", "anthropic"].every((p) => typeof KEY_PROBES[p as AiProvider] === "function"));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll AI key check checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
