/**
 * Which OAuth token-endpoint answers mean "this grant is dead, reconnect" rather than
 * "try again later". A wrong "transient" keeps a dead Outlook/Google row `active` and failing
 * forever with no alert; a wrong "dead" flags every account the day a provider has an outage.
 *
 * Run: npx tsx scripts/smoke-oauth-refresh-rejection.ts
 */
import { isRefreshRejection } from "../src/lib/errors";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

console.log("dead grants → reconnect");
for (const [status, body] of [
  [400, '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}'],
  [401, '{"error":"invalid_client"}'],
  [400, '{"error":"unauthorized_client"}'],
  [400, '{"error":"interaction_required","error_description":"AADSTS50076: multi-factor authentication required"}'],
  [400, '{"error":"consent_required","error_description":"AADSTS65001: The user or administrator has not consented"}'],
  [400, '{"error":"login_required"}'],
  [400, '{"error":"invalid_grant","error_subtype":"invalid_rapt"}'],
  [400, '{"error":"invalid_rapt"}'],
] as const) {
  check(`${status} ${body.slice(0, 48)}`, isRefreshRejection(status, body) === true);
}

console.log("transient or unrelated → retry");
for (const [status, body] of [
  [500, '{"error":"interaction_required"}'],
  [503, "Service Unavailable"],
  [429, '{"error":"rate_limited"}'],
  [400, '{"error":"invalid_request","error_description":"Missing parameter"}'],
  [403, '{"error":"access_denied"}'],
] as const) {
  check(`${status} ${body.slice(0, 48)}`, isRefreshRejection(status, body) === false);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
