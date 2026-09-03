/**
 * Exercises the pure Google OAuth scope-splitting logic: the contacts vs mailbox scope
 * sets, the incremental-auth URL builder, the scope truth table, and the OAuth `state`
 * encode/decode round-trip (including the fail-closed path for a malformed state).
 *
 * No DB, no network. The env vars below only satisfy buildGmailAuthUrl's config checks —
 * everything under test is a pure function — and must be set before `../src/lib/gmail` is
 * imported (its own env reads are lazy inside functions, but this sets them first anyway).
 *
 * Run: npx tsx scripts/smoke-google-scopes.ts
 */
process.env.GOOGLE_CLIENT_ID = "test";
process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/api/gmail/callback";

import {
  buildGmailAuthUrl,
  googleScopesFor,
  hasContactsScope,
  hasMailboxScope,
  hasSendScope,
} from "../src/lib/gmail";
import {
  decodeGmailOAuthState,
  encodeGmailOAuthState,
} from "../src/lib/gmail-oauth-state";

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  console.log("Google OAuth scope-split smoke test…");

  console.log("\nscope sets");
  const contactsScopes = googleScopesFor("contacts");
  const mailboxScopes = googleScopesFor("mailbox");
  check(
    "contacts set excludes gmail.readonly",
    !contactsScopes.includes(GMAIL_READONLY_SCOPE),
    contactsScopes
  );
  check(
    "contacts set excludes gmail.send",
    !contactsScopes.includes(GMAIL_SEND_SCOPE),
    contactsScopes
  );
  check(
    "contacts set includes contacts.readonly",
    contactsScopes.includes(CONTACTS_SCOPE),
    contactsScopes
  );
  check(
    "mailbox set includes gmail.readonly",
    mailboxScopes.includes(GMAIL_READONLY_SCOPE),
    mailboxScopes
  );
  check(
    "mailbox set includes gmail.send",
    mailboxScopes.includes(GMAIL_SEND_SCOPE),
    mailboxScopes
  );
  check(
    "mailbox set includes contacts.readonly",
    mailboxScopes.includes(CONTACTS_SCOPE),
    mailboxScopes
  );

  console.log("\nauth url");
  const authUrl = buildGmailAuthUrl("s", "contacts");
  const parsedAuthUrl = new URL(authUrl);
  check(
    "auth url requests incremental auth",
    parsedAuthUrl.searchParams.get("include_granted_scopes") === "true",
    authUrl
  );
  check("auth url keeps consent prompt", parsedAuthUrl.searchParams.get("prompt") === "consent");
  check(
    "auth url keeps offline access",
    parsedAuthUrl.searchParams.get("access_type") === "offline"
  );
  check(
    "auth url carries the contacts scope",
    (parsedAuthUrl.searchParams.get("scope") ?? "").includes(CONTACTS_SCOPE),
    authUrl
  );
  check(
    "contacts auth url omits the mailbox scopes",
    !(parsedAuthUrl.searchParams.get("scope") ?? "").includes(GMAIL_READONLY_SCOPE)
  );

  console.log("\nscope truth table");
  check("contacts set: hasContactsScope", hasContactsScope(contactsScopes) === true);
  check("contacts set: hasMailboxScope", hasMailboxScope(contactsScopes) === false);
  check("contacts set: hasSendScope", hasSendScope(contactsScopes) === false);
  check("mailbox set: hasContactsScope", hasContactsScope(mailboxScopes) === true);
  check("mailbox set: hasMailboxScope", hasMailboxScope(mailboxScopes) === true);
  check("mailbox set: hasSendScope", hasSendScope(mailboxScopes) === true);
  check("null: hasContactsScope", hasContactsScope(null) === false);
  check("null: hasMailboxScope", hasMailboxScope(null) === false);
  check("null: hasSendScope", hasSendScope(null) === false);

  console.log("\noauth state round-trip");
  const state = encodeGmailOAuthState({
    userId: "user_123",
    nonce: "nonce-abc",
    returnTo: "/onboarding/wizard?x=a:b",
    scopes: "contacts",
  });
  const decoded = decodeGmailOAuthState(state);
  check("round-trip decodes", decoded !== null, state);
  check("round-trip userId", decoded?.userId === "user_123");
  check("round-trip nonce", decoded?.nonce === "nonce-abc");
  check(
    "round-trip returnTo preserves the embedded colon",
    decoded?.returnTo === "/onboarding/wizard?x=a:b",
    decoded?.returnTo
  );
  check("round-trip scopes", decoded?.scopes === "contacts");

  const emptyReturnTo = decodeGmailOAuthState(
    encodeGmailOAuthState({ userId: "u", nonce: "n", returnTo: "", scopes: "mailbox" })
  );
  check(
    "empty returnTo round-trips to empty string",
    emptyReturnTo !== null && emptyReturnTo.returnTo === ""
  );
  check("mailbox scopes round-trip too", emptyReturnTo?.scopes === "mailbox");

  console.log("\nmalformed state fails closed");
  check("too few fields -> null", decodeGmailOAuthState("only:three:fields") === null);
  check("unknown scope set -> null", decodeGmailOAuthState("u:n:ret:bogus") === null);
  check("missing scope field entirely -> null", decodeGmailOAuthState("u:n:ret") === null);
  check("empty string -> null", decodeGmailOAuthState("") === null);
  check("missing userId -> null", decodeGmailOAuthState(":n:ret:contacts") === null);
  check("missing nonce -> null", decodeGmailOAuthState("u::ret:contacts") === null);

  console.log("\nall Google OAuth scope-split checks passed");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
