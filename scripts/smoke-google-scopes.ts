/**
 * Each Google entry point asks for its own scope (plus the two identity scopes), never all
 * six at once — the consent screen must not ask to "send email on your behalf" of someone
 * importing their address book (audit B5). Stored grants are read by exact token, and a
 * token response with no `scope` must never be recorded as every scope granted.
 *
 * Run: npx tsx scripts/smoke-google-scopes.ts
 */
import {
  GOOGLE_CONNECT_PURPOSES,
  GOOGLE_PURPOSES,
  GOOGLE_SCOPES,
  googleScopesFor,
  grantCovers,
  hasGmailReadScope,
  isGooglePurpose,
  missingGooglePurposes,
  missingScopeMessage,
  parseGooglePurposes,
  requiredScopeFor,
  serializeGooglePurposes,
  unionScopes,
} from "../src/lib/google-scopes";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const identity = [GOOGLE_SCOPES.openid, GOOGLE_SCOPES.email];
const legacyAllSix = Object.values(GOOGLE_SCOPES).join(" ");

console.log("Scopes per purpose");
for (const purpose of GOOGLE_PURPOSES) {
  const scopes = googleScopesFor([purpose]);
  check(`${purpose} asks for exactly identity + one scope`, scopes.length === 3 && identity.every((s) => scopes.includes(s)), scopes.join(" "));
  check(`${purpose}'s one scope is its required scope`, scopes[2] === requiredScopeFor(purpose));
}
check("contacts never asks to send or read mail", !googleScopesFor(["contacts"]).some((s) => s === GOOGLE_SCOPES.gmailSend || s === GOOGLE_SCOPES.gmailRead));
check("send asks for gmail.send, not gmail.readonly", requiredScopeFor("send") === GOOGLE_SCOPES.gmailSend && !googleScopesFor(["send"]).includes(GOOGLE_SCOPES.gmailRead));
check("the recruiter scan and confirmation emails both need gmail.readonly", requiredScopeFor("recruiter_scan") === GOOGLE_SCOPES.gmailRead && requiredScopeFor("event_mail") === GOOGLE_SCOPES.gmailRead);
check("calendar asks for calendar.readonly", requiredScopeFor("calendar") === GOOGLE_SCOPES.calendar);

console.log("Purposes from untrusted input");
check("a known purpose is accepted", isGooglePurpose("contacts"));
check("an unknown purpose is refused", !isGooglePurpose("everything") && !isGooglePurpose(undefined) && !isGooglePurpose(""));

console.log("Reading a stored grant");
check("gmail.readonly is found by exact token", hasGmailReadScope(`openid ${GOOGLE_SCOPES.gmailRead}`));
check("a longer look-alike is not a match", !hasGmailReadScope(`${GOOGLE_SCOPES.gmailRead}.extra`));
check("an empty or null grant covers nothing", !hasGmailReadScope("") && !hasGmailReadScope(null));
check("a legacy all-scopes grant still covers calendar", grantCovers("calendar", legacyAllSix));
check("a contacts-only grant does not cover the recruiter scan", !grantCovers("recruiter_scan", `openid ${GOOGLE_SCOPES.email} ${GOOGLE_SCOPES.contacts}`));

console.log("Merging grants");
check("no scope anywhere stores an empty grant", unionScopes(null, undefined) === "");
check("a new grant adds to the stored one, without duplicates", unionScopes("a b", "b c") === "a b c");
check("a refresh that omits scope keeps the stored grant", unionScopes("openid x", undefined) === "openid x");

console.log("Copy");
check("mail purposes say mail", missingScopeMessage("recruiter_scan") === "Google didn’t grant mail access — reconnect and allow it" && missingScopeMessage("event_mail") === missingScopeMessage("recruiter_scan"));
check("an unknown purpose falls back to the mail copy", missingScopeMessage(null) === missingScopeMessage("recruiter_scan"));
check("contacts says contacts", missingScopeMessage("contacts") === "Google didn’t grant contacts access — reconnect and allow it");
check("calendar says calendar", missingScopeMessage("calendar") === "Google didn’t grant calendar access — reconnect and allow it");
check("send says send", missingScopeMessage("send") === "Google didn’t grant permission to send — reconnect and allow it");

console.log("\nconnecting to several features at once");
const connect = googleScopesFor(GOOGLE_CONNECT_PURPOSES);
check("one connect asks for contacts and calendar", connect.includes(GOOGLE_SCOPES.contacts) && connect.includes(GOOGLE_SCOPES.calendar));
check("and never for mail", !connect.includes(GOOGLE_SCOPES.gmailRead) && !connect.includes(GOOGLE_SCOPES.gmailSend));
check("identity scopes ride along once", connect.filter((s) => s === GOOGLE_SCOPES.openid).length === 1);
check("a repeated purpose asks once", googleScopesFor(["contacts", "contacts"]).filter((s) => s === GOOGLE_SCOPES.contacts).length === 1);
check("one purpose still works", googleScopesFor(["recruiter_scan"]).includes(GOOGLE_SCOPES.gmailRead));

console.log("\nwhat the consent screen came back with");
const both = `${GOOGLE_SCOPES.contacts} ${GOOGLE_SCOPES.calendar}`;
check("nothing missing when both were granted", missingGooglePurposes(GOOGLE_CONNECT_PURPOSES, both).length === 0);
check(
  "calendar unticked is reported, contacts is not",
  missingGooglePurposes(GOOGLE_CONNECT_PURPOSES, GOOGLE_SCOPES.contacts).join(",") === "calendar"
);
check("nothing granted reports both", missingGooglePurposes(GOOGLE_CONNECT_PURPOSES, "").length === 2);

console.log("\ncarrying the purposes through the consent round trip");
check("a list round-trips", parseGooglePurposes(serializeGooglePurposes(GOOGLE_CONNECT_PURPOSES)).join(",") === "contacts,calendar");
check("a consent screen already in flight still parses", parseGooglePurposes("recruiter_scan").join(",") === "recruiter_scan");
check("junk is dropped, not trusted", parseGooglePurposes("contacts.nonsense").join(",") === "contacts");
check("empty is empty", parseGooglePurposes("").length === 0 && parseGooglePurposes(null).length === 0);

console.log("\nbackward compatibility with old separator");
check("a consent screen that left before the separator changed still parses", parseGooglePurposes("contacts+calendar").join(",") === "contacts,calendar");
check("and the current form still parses", parseGooglePurposes("contacts.calendar").join(",") === "contacts,calendar");
check("a mixed pair parses too", parseGooglePurposes("contacts+calendar.recruiter_scan").length === 3);
check("junk in either form is still dropped", parseGooglePurposes("contacts+nonsense.calendar").join(",") === "contacts,calendar");

// Through a real URL rather than through memory. RFC 6749 sends the state back to the redirect
// URI form-urlencoded, where a literal `+` decodes to a SPACE — so a separator that only looks
// safe in a string comparison still turns `contacts+calendar` into `contacts calendar` the
// moment a provider echoes the value it decoded, and `consumeGmailOAuthState` rejects it.
const state = `user_2abc:11111111-2222-3333-4444-555555555555::${serializeGooglePurposes(GOOGLE_CONNECT_PURPOSES)}`;
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ state })}`;
const sentState = new URL(authUrl).searchParams.get("state");
check("the state reaches the consent screen unchanged", sentState === state, String(sentState));
// And the way back, with the state placed on the redirect raw — a provider re-emitting what it
// decoded, which is the leg that percent-encoding on the way out does not protect.
const echoedState = new URL(`https://orbit.test/api/gmail/callback?code=abc&state=${state}`).searchParams.get("state");
check("and comes back off the redirect unchanged", echoedState === state, String(echoedState));
check(
  "its fourth field still names both purposes",
  parseGooglePurposes((echoedState ?? "").split(":")[3]).join(",") === "contacts,calendar"
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Google scope checks passed.");
process.exit(0);
