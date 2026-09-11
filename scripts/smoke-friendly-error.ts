/**
 * Guards `friendlyError` — the rule that a toast shows the caller's copy, never
 * `err.message` — and the AI failure templates it lets through.
 *
 * The case most worth keeping: every rewritten AI template must still CLASSIFY to its own
 * kind. `lib/ai.ts` throws the output of `aiProviderErrorMessage`, and `withUsage` in
 * `lib/usage-events.ts` classifies that already-rewritten error for
 * `usage_events.error_kind`. Reword a template without its trigger word and that failure
 * kind silently becomes "other" in telemetry — nothing else would notice.
 *
 * Also covers `UserFacingError` / `asActionResult` (which messages survive the Server
 * Action boundary) and `describeOAuthReason` (a cancelled consent screen is not an error).
 *
 * Run: npx tsx scripts/smoke-friendly-error.ts
 */
import {
  friendlyError,
  aiProviderErrorMessage,
  classifyAiError,
  MISSING_AI_API_KEY_MESSAGE,
  OFFLINE_MESSAGE,
  TIMEOUT_MESSAGE,
  AI_PROVIDER_LABELS,
  UserFacingError,
  asActionResult,
  describeOAuthReason,
} from "../src/lib/errors";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}`, extra ?? "");
}
const FB = "That didn’t save — try again?";

console.log("the Next production digest never reaches a person");
const digest = new Error("An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details. A digest property is included on this Error instance which may provide additional details about the nature of the error.");
check("digest → fallback", friendlyError(digest, FB) === FB, friendlyError(digest, FB));
check("empty Error → fallback", friendlyError(new Error(""), FB) === FB);

console.log("raw provider and internal text never reaches a person");
for (const raw of [
  'Google Calendar 403: {"error":{"code":403,"message":"insufficient scope"}}',
  "Apollo search failed (500): upstream exploded",
  'Failed to parse AI JSON: {"peo',
  "Token exchange failed: invalid_client",
  "Token refresh failed: invalid_grant",
  "ensureUserSettings: no row for user_2abc after an insert race",
  "Gmail send failed: 429 Too Many Requests",
  "Unknown surface: foo",
  "Cannot read properties of undefined (reading 'id')",
]) {
  check(`fallback for: ${raw.slice(0, 44)}`, friendlyError(new Error(raw), FB) === FB, friendlyError(new Error(raw), FB));
}

console.log("non-Error throws");
check("null → fallback", friendlyError(null, FB) === FB);
check("undefined → fallback", friendlyError(undefined, FB) === FB);
check("junk string → fallback", friendlyError("db exploded", FB) === FB);
check("junk object → fallback", friendlyError({ message: "SELECT * FROM users" }, FB) === FB);

console.log("a missing AI key is worth saying out loud");
check("no-key error → the key message", friendlyError(new Error("No API key configured for gemini"), FB) === MISSING_AI_API_KEY_MESSAGE, friendlyError(new Error("No API key configured for gemini"), FB));

console.log("the connection is worth saying out loud, because the fallback would blame the wrong thing");
check("Chrome", friendlyError(new TypeError("Failed to fetch"), FB) === OFFLINE_MESSAGE);
check("Firefox", friendlyError(new TypeError("NetworkError when attempting to fetch resource."), FB) === OFFLINE_MESSAGE);
check("Safari", friendlyError(new TypeError("Load failed"), FB) === OFFLINE_MESSAGE);
check("a plain Error saying 'Load failed' is NOT a network error", friendlyError(new Error("Load failed"), FB) === FB, "only a TypeError from fetch counts");

console.log("so is a timeout");
const abort = new Error("The operation was aborted."); abort.name = "AbortError";
check("AbortError → timeout copy", friendlyError(abort, FB) === TIMEOUT_MESSAGE, friendlyError(abort, FB));
const to = new Error("x"); to.name = "TimeoutError";
check("TimeoutError → timeout copy", friendlyError(to, FB) === TIMEOUT_MESSAGE);

console.log("our own AI wording passes through, for every provider, every kind");
const kinds: [string, unknown, string][] = [
  ["auth", new Error("401 Unauthorized: invalid x-api-key"), "auth"],
  ["rate_limit", new Error("429 RESOURCE_EXHAUSTED quota"), "rate_limit"],
  ["timeout", new Error("Request timed out"), "timeout"],
  ["model_unavailable", new Error("404 model not found"), "model_unavailable"],
  ["other", new Error('{"secret":"sk-live-123","trace":"at foo"}'), "other"],
];
for (const label of AI_PROVIDER_LABELS) {
  for (const [kind, raw, expected] of kinds) {
    const msg = aiProviderErrorMessage(raw, label);
    check(`${label}/${kind}: passes through friendlyError`, friendlyError(new Error(msg), FB) === msg, msg);
    // The load-bearing one: withUsage classifies the ALREADY-rewritten error.
    check(`${label}/${kind}: telemetry still classifies it as ${expected}`, classifyAiError(new Error(msg)) === expected, `${classifyAiError(new Error(msg))} ← "${msg}"`);
  }
}

console.log("the catch-all no longer repeats whatever the provider said");
const leaky = aiProviderErrorMessage(new Error('{"secret":"sk-live-123","trace":"at foo (/srv/x.ts:9)"}'), "Gemini");
check("no secret", !leaky.includes("sk-live"), leaky);
check("no stack/path", !leaky.includes("/srv/") && !leaky.includes("trace"), leaky);
check("no 'server env' jargon anywhere", !kinds.some(([, raw]) => aiProviderErrorMessage(raw, "Gemini").toLowerCase().includes("env")));

console.log("house voice");
const all = [MISSING_AI_API_KEY_MESSAGE, OFFLINE_MESSAGE, TIMEOUT_MESSAGE, ...kinds.map(([, raw]) => aiProviderErrorMessage(raw, "Gemini"))];
check("no straight apostrophes", all.every((m) => !m.includes("'")), all.filter((m) => m.includes("'")));
check("no trailing period", all.every((m) => !m.endsWith(".")), all.filter((m) => m.endsWith(".")));
check("no 'Could not' / 'Failed to'", all.every((m) => !/Could not|Failed to/.test(m)));

console.log("a UserFacingError is written to be read, so it passes through");
check("verbatim", friendlyError(new UserFacingError("Give it a title first"), FB) === "Give it a title first");
const imposter = new Error("Connect Gmail before sending"); imposter.name = "UserFacingError";
check("recognised by name too (second module instance)", friendlyError(imposter, FB) === "Connect Gmail before sending");
check("an ordinary Error with the same text does NOT pass", friendlyError(new Error("Connect Gmail before sending"), FB) === FB);

console.log("OAuth reasons");
check("a cancel is not an error", describeOAuthReason("access_denied", "Gmail").cancelled === true);
check("…and reads as one", /cancelled/.test(describeOAuthReason("access_denied", "Gmail").message));
check("a raw token-endpoint body never shows", describeOAuthReason('Token exchange failed: {"error":"invalid_client"}', "Gmail").message === "Couldn’t connect Gmail — try again?");
check("no reason at all", describeOAuthReason(null, "Outlook").message === "Couldn’t connect Outlook — try again?");

(async () => {
  console.log("asActionResult");
  const okR = await asActionResult(async () => 42);
  check("success is { ok: true, value }", okR.ok === true && okR.value === 42);
  const bad = await asActionResult(async () => { throw new UserFacingError("A list with that name already exists"); });
  check("a UserFacingError comes back as data", bad.ok === false && bad.error === "A list with that name already exists");
  let rethrown = false;
  try { await asActionResult(async () => { throw new Error("db exploded"); }); } catch { rethrown = true; }
  check("anything else is rethrown, not swallowed", rethrown);
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
