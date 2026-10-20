#!/usr/bin/env node
/**
 * Secret scan for CI (FIX_PLAN Phase 4.4): fails when a tracked file holds a live credential
 * in a format that is unambiguous (provider prefixes, private key blocks, a database URL with
 * a password). No dependency and no network; it reads `git ls-files`.
 *
 *   node scripts/scan-secrets.mjs
 *
 * A match prints the file, line and pattern name, never the value. A deliberate placeholder
 * (a fixture that has to look like a key) goes in ALLOW below, keyed by file and pattern,
 * with why. This complements GitHub's own secret scanning and push protection, which the
 * repository owner turns on in Settings → Code security; it does not replace them.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const PATTERNS = [
  ["stripe-live-secret", /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/],
  ["stripe-webhook-secret", /\bwhsec_[0-9A-Za-z]{24,}/],
  ["clerk-live-secret", /\bsk_live_[0-9A-Za-z]{20,}/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["anthropic-key", /\bsk-ant-[0-9A-Za-z_-]{32,}/],
  ["openai-key", /\bsk-(?:proj-|svcacct-)?[0-9A-Za-z_-]{40,}/],
  ["openrouter-key", /\bsk-or-v1-[0-9a-f]{40,}/],
  ["github-token", /\b(?:gh[pousr]_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z_]{60,})/],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{20,}/],
  ["resend-key", /\bre_[0-9A-Za-z]{8}_[0-9A-Za-z]{20,}/],
  ["private-key-block", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
  ["postgres-url-with-password", /\bpostgres(?:ql)?:\/\/[^\s:/@]+:[^\s@]{8,}@[^\s/]*\.(?:neon\.tech|amazonaws\.com|supabase\.co|render\.com)/],
];

/** `file :: pattern` → why it is not a secret. */
const ALLOW = {
  "scripts/scan-secrets.mjs :: private-key-block": "the pattern itself",
  "scripts/smoke-ai-guardrails.ts :: private-key-block": "a truncated PEM the stream-redactor test must scrub",
  "scripts/smoke-radar-run.ts :: anthropic-key": "a placeholder key in a model reply the output guard must scrub",
  "scripts/smoke-radar-run.ts :: openai-key": "the same placeholder, which also matches the generic sk- shape",
  "scripts/smoke-route-errors.ts :: anthropic-key": "a placeholder key in an error message the log scrubber must remove",
  "scripts/smoke-route-errors.ts :: openai-key": "the same placeholder, which also matches the generic sk- shape",
};

const SKIP = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp3|mp4|wav|pdf|zip|gz|lock)$|^package-lock\.json$/;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const hits = [];
let scanned = 0;
for (const file of files) {
  if (SKIP.test(file)) continue;
  let st;
  try {
    st = statSync(file);
  } catch {
    continue; // deleted in the working tree
  }
  if (!st.isFile() || st.size > 2 * 1024 * 1024) continue; // a submodule path, or too big to be source
  const text = readFileSync(file, "utf8");
  if (text.includes("\u0000")) continue; // binary
  scanned++;
  const lines = text.split("\n");
  for (const [name, re] of PATTERNS) {
    if (ALLOW[`${file} :: ${name}`]) continue;
    lines.forEach((line, i) => {
      if (re.test(line)) hits.push(`${file}:${i + 1}  ${name}`);
    });
  }
}

if (hits.length) {
  console.error(`Secret scan: ${hits.length} possible credential(s) in tracked files (values not shown):`);
  for (const h of hits) console.error(`  ${h}`);
  console.error("\nRotate any real credential first, then remove it from the file. A deliberate placeholder");
  console.error("goes in ALLOW in scripts/scan-secrets.mjs with the reason.");
  process.exit(1);
}
console.log(`Secret scan clean: ${scanned} tracked files, ${PATTERNS.length} patterns.`);
