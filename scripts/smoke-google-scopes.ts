/**
 * Each Google entry point asks for its own scope (plus the two identity scopes), never all
 * six at once — the consent screen must not ask to "send email on your behalf" of someone
 * importing their address book (audit B5). Stored grants are read by exact token, and a
 * token response with no `scope` must never be recorded as every scope granted.
 *
 * Run: npx tsx scripts/smoke-google-scopes.ts
 */
import {
  GOOGLE_PURPOSES,
  GOOGLE_SCOPES,
  googleScopesFor,
  grantCovers,
  hasGmailReadScope,
  isGooglePurpose,
  missingScopeMessage,
  requiredScopeFor,
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
  const scopes = googleScopesFor(purpose);
  check(`${purpose} asks for exactly identity + one scope`, scopes.length === 3 && identity.every((s) => scopes.includes(s)), scopes.join(" "));
  check(`${purpose}'s one scope is its required scope`, scopes[2] === requiredScopeFor(purpose));
}
check("contacts never asks to send or read mail", !googleScopesFor("contacts").some((s) => s === GOOGLE_SCOPES.gmailSend || s === GOOGLE_SCOPES.gmailRead));
check("send asks for gmail.send, not gmail.readonly", requiredScopeFor("send") === GOOGLE_SCOPES.gmailSend && !googleScopesFor("send").includes(GOOGLE_SCOPES.gmailRead));
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

console.log("Drive");
// Drive: files the person picks, nothing else — never a restricted Drive scope.
check("drive is a purpose", isGooglePurpose("drive"));
check(
  "drive asks for drive.file only",
  requiredScopeFor("drive") === "https://www.googleapis.com/auth/drive.file",
);
check(
  "drive consent = identity + drive.file",
  JSON.stringify(googleScopesFor("drive")) ===
    JSON.stringify([...identity, GOOGLE_SCOPES.drive]),
);
check(
  "no restricted Drive scope anywhere",
  !Object.values(GOOGLE_SCOPES).some((s) => /drive\.(readonly|metadata)/.test(s)),
);
check(
  "a contacts-only grant doesn't cover drive",
  !grantCovers("drive", `openid ${GOOGLE_SCOPES.contacts}`),
);
check(
  "missing drive scope has its own line",
  missingScopeMessage("drive") === "Google didn’t grant Drive access — reconnect and allow it",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Google scope checks passed.");
process.exit(0);
