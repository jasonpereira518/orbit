/**
 * Credentials that live in a URL never reach Sentry. See `src/lib/sentry-scrub.ts`.
 *
 * Pure tier: string rewriting only.
 */
import { scrubSentryEvent, scrubUrl } from "../src/lib/sentry-scrub";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const cases: Array<[string, string, string]> = [
  ["calendar feed token", "https://orbit.app/api/calendar/AbC-123_x", "https://orbit.app/api/calendar/[redacted]"],
  ["scan page token", "/scan/tok123?x=1", "/scan/[redacted]?x=1"],
  ["scan API token", "/api/scan/tok123/pages", "/api/scan/[redacted]/pages"],
  ["MCP URL key", "/api/mcp/mcpk_live_abc", "/api/mcp/[redacted]"],
  ["health token query", "/api/health?token=s3cret&deep=1", "/api/health?token=[redacted]&deep=1"],
  ["OAuth code and state", "/api/gmail/callback?code=4/abc&state=xyz", "/api/gmail/callback?code=[redacted]&state=[redacted]"],
];
for (const [label, input, expected] of cases) {
  const got = scrubUrl(input);
  check(`redacts the ${label}`, got === expected, got);
}
check("leaves the bare MCP endpoint alone", scrubUrl("/api/mcp") === "/api/mcp");
check("leaves a route pattern alone", scrubUrl("/api/calendar/[token]") === "/api/calendar/[token]");
check("leaves ordinary pages alone", scrubUrl("/contacts/123?tab=notes") === "/contacts/123?tab=notes");

const event = scrubSentryEvent({
  request: { url: "https://orbit.app/api/calendar/secret", query_string: "token=secret" },
  transaction: "GET /scan/secret",
  breadcrumbs: [{ data: { url: "/api/mcp/secret", from: "/scan/secret", to: "/dashboard" } }],
});
check("scrubs the whole event", !JSON.stringify(event).includes("secret"), JSON.stringify(event));

if (failures) {
  console.error(`\n${failures} scrub check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Sentry scrub checks passed.");
