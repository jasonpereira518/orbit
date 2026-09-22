/**
 * Reading an OAuth callback's result off the URL: what to say, and what the URL becomes.
 * Also: which returnTo values may become the redirect after the consent screen.
 * Run: npx tsx scripts/smoke-oauth-return.ts
 */
import { readOAuthReturn, safeReturnPath } from "../src/lib/oauth-return";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const OPTS = {
  param: "eventbrite",
  provider: "Eventbrite",
  connectedText: "Eventbrite connected — events you host will sync automatically",
  reasons: { no_organization: "That Eventbrite account has no organization to sync — create one on Eventbrite, then connect again" },
};

const ok = readOAuthReturn("?eventbrite=connected&tab=hosts", OPTS);
check("connected is a success toast", ok?.tone === "success" && ok.text === OPTS.connectedText, JSON.stringify(ok));
check("…and keeps unrelated params", ok?.nextSearch === "?tab=hosts", ok?.nextSearch);

const cancel = readOAuthReturn("?eventbrite=error&reason=access_denied", OPTS);
check("a cancel is a quiet message", cancel?.tone === "message" && /cancelled/.test(cancel.text), JSON.stringify(cancel));
check("…and strips both params", cancel?.nextSearch === "", cancel?.nextSearch);

const noOrg = readOAuthReturn("?eventbrite=error&reason=no_organization", OPTS);
check("a known reason gets its own copy", noOrg?.tone === "error" && noOrg.text === OPTS.reasons.no_organization);

const failed = readOAuthReturn("?eventbrite=error&reason=oauth_failed", OPTS);
check("anything else gets the generic copy", failed?.tone === "error" && failed.text === "Couldn’t connect Eventbrite — try again?", failed?.text);

check("no param, no toast", readOAuthReturn("?tab=hosts&reason=x", OPTS) === null);
check("an unknown value is ignored", readOAuthReturn("?eventbrite=maybe", OPTS) === null);

// returnTo: only a path on this origin may become the post-consent redirect.
check("a same-origin path passes", safeReturnPath("/settings?integration=google") === "/settings?integration=google");
for (const [label, value] of [
  ["a protocol-relative URL", "//evil.example"],
  ["a backslash that parses as //", "/\\evil.example"],
  ["an absolute URL", "https://evil.example"],
  ["an empty string", ""],
  ["null", null],
  ["a newline", "/settings\n//evil.example"],
  ["a tab between the slashes", "/\t/evil.example"],
] as const) {
  check(`${label} is rejected`, safeReturnPath(value) === null, JSON.stringify(value));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
