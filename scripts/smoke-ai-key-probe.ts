/**
 * Pure-logic smoke test for the AI key probe's error classification and the in-memory
 * rate limiter. No DB, no network: `probeAiKey` itself calls out to the provider SDKs, so
 * it isn't exercised here — only the pure mapping it shares with `verifyAndSaveAiKey`
 * (`probeReasonFromError`, and `classifyAiError` for the rate-limit carve-out) and
 * `takeToken`'s sliding window.
 *
 * Run: npx tsx scripts/smoke-ai-key-probe.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { probeReasonFromError } from "../src/lib/ai-key-probe";
import { classifyAiError } from "../src/lib/errors";
import { takeToken } from "../src/lib/rate-limit";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("AI key probe smoke test (no DB, no network)…");

  /* ------------------------------------------------------- error → probe reason mapping */
  console.log("\nprobeReasonFromError");

  // Shaped like OpenAI/Anthropic 401s and a Gemini "invalid API key" rejection.
  const openAiAuth = new Error(
    "401 Incorrect API key provided: sk-***. You can find your API key at https://platform.openai.com/account/api-keys.",
  );
  const anthropicAuth = new Error(
    '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  );
  const geminiAuth = new Error(
    "[GoogleGenerativeAI Error]: API key not valid. Please pass a valid API key. [400 Bad Request]",
  );
  // A 403 permission error that still names the API key — the other shape these SDKs throw
  // for a rejected/restricted key.
  const anthropicForbidden = new Error(
    '403 {"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use this endpoint."}}',
  );
  check("OpenAI 401 -> invalid", probeReasonFromError(openAiAuth) === "invalid");
  check("Anthropic 401 -> invalid", probeReasonFromError(anthropicAuth) === "invalid");
  check("Gemini invalid-key -> invalid", probeReasonFromError(geminiAuth) === "invalid");
  check("Anthropic 403 permission error -> invalid", probeReasonFromError(anthropicForbidden) === "invalid");

  // Shaped like a 404 for an unknown/unavailable model.
  const openAiModel404 = new Error(
    "404 The model `gpt-99-nonexistent` does not exist or you do not have access to it.",
  );
  const geminiModel404 = new Error(
    "models/gemini-99-fake is not found for API version v1beta, or is not supported for generateContent.",
  );
  check("OpenAI model 404 -> no_access", probeReasonFromError(openAiModel404) === "no_access");
  check("Gemini model 404 -> no_access", probeReasonFromError(geminiModel404) === "no_access");

  // Shaped like a timeout and a raw connection failure — neither is auth or model-shaped,
  // and both should land in the same "couldn't reach the provider" bucket.
  const timeoutErr = new Error("Request timed out after 30000ms");
  const abortErr = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  const econnrefused = new Error("connect ECONNREFUSED 127.0.0.1:443");
  check("timeout message -> network", probeReasonFromError(timeoutErr) === "network");
  check("AbortError -> network", probeReasonFromError(abortErr) === "network");
  check(
    "ECONNREFUSED (unclassified) -> network",
    probeReasonFromError(econnrefused) === "network",
  );

  /* -------------------------------------------------- 429 proves the key authenticates */
  console.log("\n429 -> ok (via the shared classification path)");

  // probeAiKey treats a rate_limit classification as a successful probe before ever
  // calling probeReasonFromError — this is the same classifyAiError() call it makes.
  const rateLimited = new Error("429 Too Many Requests: Resource has been exhausted (e.g. check quota).");
  check(
    "429/quota message classifies as rate_limit (probeAiKey turns this into { ok: true })",
    classifyAiError(rateLimited) === "rate_limit",
  );

  /* --------------------------------------------------------------------- takeToken */
  console.log("\ntakeToken sliding window");

  const opts = { max: 3, windowMs: 200 };
  const key = "smoke-test-key";
  check("1st call allowed", takeToken(key, opts) === true);
  check("2nd call allowed", takeToken(key, opts) === true);
  check("3rd call allowed", takeToken(key, opts) === true);
  check("4th call refused (over max)", takeToken(key, opts) === false);
  check("...still refused immediately after", takeToken(key, opts) === false);

  await sleep(opts.windowMs + 50);
  check("allowed again once the window has fully elapsed", takeToken(key, opts) === true);

  // A separate key gets its own bucket.
  check("a different key is unaffected by another key's usage", takeToken("other-key", opts) === true);

  console.log("\nAll AI key probe checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
