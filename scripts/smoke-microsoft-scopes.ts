/**
 * Each Outlook entry point asks for its own Graph scope (plus identity), never all three at
 * once — the consent screen must not ask to read mail of someone importing their address book
 * (audit B5, Microsoft side). Stored grants are read by exact token AFTER normalizing, because
 * Microsoft echoes scopes as short names or full URIs, in any case, and a case-sensitive URI
 * test would read a real calendar grant as "none" and silently disarm calendar sync.
 *
 * Run: npx tsx scripts/smoke-microsoft-scopes.ts
 */
import {
  MICROSOFT_CONNECT_PURPOSES,
  MICROSOFT_PURPOSES,
  MICROSOFT_SCOPES,
  grantCovers,
  hasCalendarScope,
  hasContactsScope,
  hasMailScope,
  hasScope,
  isMicrosoftPurpose,
  microsoftScopesFor,
  missingMicrosoftPurposes,
  missingScopeMessage,
  normalizeScope,
  parseMicrosoftPurposes,
  requiredScopeFor,
  serializeMicrosoftPurposes,
  unionScopes,
} from "../src/lib/microsoft-scopes";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const identity = [
  MICROSOFT_SCOPES.openid,
  MICROSOFT_SCOPES.profile,
  MICROSOFT_SCOPES.email,
  MICROSOFT_SCOPES.offlineAccess,
  MICROSOFT_SCOPES.userRead,
];
const featureScopes: string[] = [MICROSOFT_SCOPES.contacts, MICROSOFT_SCOPES.calendar, MICROSOFT_SCOPES.mail];

console.log("Scopes per purpose");
for (const purpose of MICROSOFT_PURPOSES) {
  const scopes = microsoftScopesFor([purpose]);
  check(`${purpose} asks for exactly identity + one scope`, scopes.length === identity.length + 1 && identity.every((s) => scopes.includes(s)), scopes.join(" "));
  check(`${purpose}'s one scope is its required scope`, scopes.filter((s) => featureScopes.includes(s)).join() === requiredScopeFor(purpose));
}
check("contacts never asks to read mail or calendar", !microsoftScopesFor(["contacts"]).some((s) => s === MICROSOFT_SCOPES.mail || s === MICROSOFT_SCOPES.calendar));
check("calendar never asks to read mail or contacts", !microsoftScopesFor(["calendar"]).some((s) => s === MICROSOFT_SCOPES.mail || s === MICROSOFT_SCOPES.contacts));
check("the recruiter scan asks for Mail.Read only", requiredScopeFor("recruiter_scan") === MICROSOFT_SCOPES.mail && !microsoftScopesFor(["recruiter_scan"]).includes(MICROSOFT_SCOPES.calendar));
check("Graph scopes are requested as full URIs", requiredScopeFor("calendar") === "https://graph.microsoft.com/Calendars.Read" && MICROSOFT_SCOPES.userRead === "https://graph.microsoft.com/User.Read");
check("a refresh token is still requested (offline_access)", microsoftScopesFor(["contacts"]).includes("offline_access"));
check("no scope is a write scope", Object.values(MICROSOFT_SCOPES).every((s) => !/write|send|readwrite/i.test(s)));

console.log("Requests carry what was already enabled — and only that");
const carried = microsoftScopesFor(["calendar"], "openid Contacts.Read User.Read AuditLog.Create");
check("an earlier contacts grant is carried into a calendar request", carried.includes(MICROSOFT_SCOPES.contacts) && carried.includes(MICROSOFT_SCOPES.calendar));
check("mail is never added unless it was already granted", !carried.includes(MICROSOFT_SCOPES.mail));
check("a scope Orbit does not own is never requested", !carried.some((s) => /auditlog/i.test(s)), carried.join(" "));
check("a carried scope is requested once, in URI form", carried.filter((s) => s === MICROSOFT_SCOPES.contacts).length === 1 && new Set(carried).size === carried.length);
check("a lower-case earlier grant is still recognised", microsoftScopesFor(["calendar"], "mail.read").includes(MICROSOFT_SCOPES.mail));
check("the purpose's own scope is not duplicated by the stored grant", microsoftScopesFor(["contacts"], "Contacts.Read").length === identity.length + 1);
check("no stored grant adds nothing", microsoftScopesFor(["contacts"], null).length === identity.length + 1 && microsoftScopesFor(["contacts"], "").length === identity.length + 1);

console.log("Purposes from untrusted input");
check("a known purpose is accepted", isMicrosoftPurpose("calendar") && isMicrosoftPurpose("recruiter_scan") && isMicrosoftPurpose("contacts"));
check("an unknown purpose is refused", !isMicrosoftPurpose("everything") && !isMicrosoftPurpose("send") && !isMicrosoftPurpose(undefined) && !isMicrosoftPurpose(""));

console.log("Normalization: short name, full URI and any case are one scope");
const forms = ["Calendars.Read", "https://graph.microsoft.com/Calendars.Read", "calendars.read", "CALENDARS.READ", "HTTPS://GRAPH.MICROSOFT.COM/calendars.read"];
for (const form of forms) {
  check(`"${form}" is calendar access`, hasCalendarScope(form) && hasCalendarScope(`openid ${form} profile`) && grantCovers("calendar", form));
  check(`"${form}" is not mail or contacts access`, !hasMailScope(form) && !hasContactsScope(form));
}
check("mail is recognised in every form", hasMailScope("Mail.Read") && hasMailScope("https://graph.microsoft.com/mail.read") && hasMailScope("MAIL.READ"));
check("contacts is recognised in every form", hasContactsScope("contacts.read") && hasContactsScope("https://graph.microsoft.com/Contacts.Read"));
check("normalizeScope strips the prefix and lower-cases", normalizeScope("https://graph.microsoft.com/Calendars.Read") === "calendars.read" && normalizeScope("OpenID") === "openid");
check("a mixed list is read token by token", hasCalendarScope("openid email Calendars.Read https://graph.microsoft.com/Mail.Read") && hasMailScope("openid email Calendars.Read https://graph.microsoft.com/Mail.Read"));
check("tabs and runs of spaces do not matter", hasCalendarScope("openid\tCalendars.Read   profile"));

console.log("Look-alikes never match");
check("Calendars.ReadWrite is not Calendars.Read", !hasCalendarScope("Calendars.ReadWrite") && !hasCalendarScope("https://graph.microsoft.com/Calendars.ReadWrite"));
check("Calendars.Read.Shared is not Calendars.Read", !hasCalendarScope("Calendars.Read.Shared"));
check("Mail.ReadBasic is not Mail.Read", !hasMailScope("Mail.ReadBasic") && !hasMailScope("https://graph.microsoft.com/Mail.ReadBasic"));
check("a prefix or suffix on a token is not a match", !hasCalendarScope("xCalendars.Read") && !hasCalendarScope("Calendars.Readx") && !hasCalendarScope("https://evil.example/Calendars.Read"));
check("another host's URI is not Graph's", !hasScope("https://graph.microsoft.com.evil.example/Calendars.Read", MICROSOFT_SCOPES.calendar));
check("an empty or null grant covers nothing", !hasCalendarScope("") && !hasCalendarScope(null) && !hasCalendarScope(undefined) && !grantCovers("contacts", null));
check("a contacts-only grant does not cover the recruiter scan", !grantCovers("recruiter_scan", `openid ${MICROSOFT_SCOPES.contacts}`));

console.log("Merging grants");
check("no scope anywhere stores an empty grant", unionScopes(null, undefined) === "" && unionScopes("", "") === "");
check("a new grant adds to the stored one, without duplicates", unionScopes("a b", "b c") === "a b c");
check("a refresh that omits scope keeps the stored grant", unionScopes("openid Contacts.Read", undefined) === "openid Contacts.Read");
check("the same scope in a different form is not stored twice", unionScopes("https://graph.microsoft.com/Contacts.Read", "contacts.read Calendars.Read") === "https://graph.microsoft.com/Contacts.Read Calendars.Read");
check("case differences dedupe too", unionScopes("Mail.Read", "MAIL.READ mail.read") === "Mail.Read");
check("a union of contacts then calendar covers both, in any form", hasContactsScope(unionScopes("Contacts.Read", "https://graph.microsoft.com/calendars.read")) && hasCalendarScope(unionScopes("Contacts.Read", "https://graph.microsoft.com/calendars.read")));
check("a union never grants what neither side had", !hasMailScope(unionScopes("Contacts.Read", "Calendars.Read")));

console.log("Copy");
check("mail purpose says mail", missingScopeMessage("recruiter_scan") === "Microsoft didn’t grant mail access — reconnect and allow it");
check("an unknown purpose falls back to the mail copy", missingScopeMessage(null) === missingScopeMessage("recruiter_scan"));
check("contacts says contacts", missingScopeMessage("contacts") === "Microsoft didn’t grant contacts access — reconnect and allow it");
check("calendar says calendar", missingScopeMessage("calendar") === "Microsoft didn’t grant calendar access — reconnect and allow it");

console.log("\nconnecting to several features at once");
const connect = microsoftScopesFor(MICROSOFT_CONNECT_PURPOSES);
check("one connect asks for contacts and calendar", connect.includes(MICROSOFT_SCOPES.contacts) && connect.includes(MICROSOFT_SCOPES.calendar));
check("and never for mail", !connect.includes(MICROSOFT_SCOPES.mail));
check("identity scopes ride along once", connect.filter((s) => s === MICROSOFT_SCOPES.openid).length === 1);
check("a repeated purpose asks once", microsoftScopesFor(["contacts", "contacts"]).filter((s) => s === MICROSOFT_SCOPES.contacts).length === 1);
check("one purpose still works", microsoftScopesFor(["recruiter_scan"]).includes(MICROSOFT_SCOPES.mail));

console.log("\nwhat the consent screen came back with");
const both = `${MICROSOFT_SCOPES.contacts} ${MICROSOFT_SCOPES.calendar}`;
check("nothing missing when both were granted", missingMicrosoftPurposes(MICROSOFT_CONNECT_PURPOSES, both).length === 0);
check(
  "calendar unticked is reported, contacts is not",
  missingMicrosoftPurposes(MICROSOFT_CONNECT_PURPOSES, MICROSOFT_SCOPES.contacts).join(",") === "calendar"
);
check("nothing granted reports both", missingMicrosoftPurposes(MICROSOFT_CONNECT_PURPOSES, "").length === 2);
check(
  "a grant stored in Graph's other spelling still counts",
  missingMicrosoftPurposes(MICROSOFT_CONNECT_PURPOSES, "contacts.read https://graph.microsoft.com/Calendars.Read").length === 0
);
check(
  "connecting keeps a mail scope the account already had",
  microsoftScopesFor(MICROSOFT_CONNECT_PURPOSES, MICROSOFT_SCOPES.mail).includes(MICROSOFT_SCOPES.mail)
);

console.log("\ncarrying the purposes through the consent round trip");
check("a list round-trips", parseMicrosoftPurposes(serializeMicrosoftPurposes(MICROSOFT_CONNECT_PURPOSES)).join(",") === "contacts,calendar");
check("a consent screen already in flight still parses", parseMicrosoftPurposes("recruiter_scan").join(",") === "recruiter_scan");
check("junk is dropped, not trusted", parseMicrosoftPurposes("contacts.nonsense").join(",") === "contacts");
check("empty is empty", parseMicrosoftPurposes("").length === 0 && parseMicrosoftPurposes(null).length === 0);

// Through a real URL rather than through memory, for the reason the Google twin gives: the
// redirect carries the state form-urlencoded, where a literal `+` decodes to a SPACE, and
// `consumeOutlookOAuthState` compares the returned state to the cookie byte for byte.
const state = `user_2abc:11111111-2222-3333-4444-555555555555::${serializeMicrosoftPurposes(MICROSOFT_CONNECT_PURPOSES)}`;
const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${new URLSearchParams({ state })}`;
const sentState = new URL(authUrl).searchParams.get("state");
check("the state reaches the consent screen unchanged", sentState === state, String(sentState));
// And the way back, with the state placed on the redirect raw — a provider re-emitting what it
// decoded, which is the leg that percent-encoding on the way out does not protect.
const echoedState = new URL(`https://orbit.test/api/outlook/callback?code=abc&state=${state}`).searchParams.get("state");
check("and comes back off the redirect unchanged", echoedState === state, String(echoedState));
check(
  "its fourth field still names both purposes",
  parseMicrosoftPurposes((echoedState ?? "").split(":")[3]).join(",") === "contacts,calendar"
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Microsoft scope checks passed.");
process.exit(0);
