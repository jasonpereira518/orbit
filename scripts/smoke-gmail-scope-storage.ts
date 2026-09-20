/**
 * The OAuth URL each entry point builds, and what the connection row stores afterwards.
 * Before Phase 1 every URL asked for all six scopes, and a token response with no `scope`
 * was stored as all six — a grant the person never gave (audit B5).
 *
 * Run: npx tsx scripts/smoke-gmail-scope-storage.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

process.env.GOOGLE_CLIENT_ID ||= "smoke-client.apps.googleusercontent.com";
process.env.GOOGLE_REDIRECT_URI ||= "http://localhost:3001/api/gmail/callback";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { gmailConnections, userSettings } from "../src/db/schema";
import { buildGmailAuthUrl, hasGmailReadScope, upsertGmailConnection } from "../src/lib/gmail";
import { GOOGLE_SCOPES, hasScope } from "../src/lib/google-scopes";
import { ensureUserSettings } from "../src/lib/user-settings";
import { findGmailGrant } from "../src/lib/events/connections";

const USER = "smoke-gmail-scope-user";
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function cleanup() {
  const db = await getDb();
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

const scopesOf = (url: string) => new URL(url).searchParams.get("scope")?.split(" ") ?? [];

run(async () => {
  console.log("Authorization URLs");
  const contactsUrl = buildGmailAuthUrl("state-contacts", "contacts");
  const contacts = scopesOf(contactsUrl);
  check("contacts asks for contacts.readonly", contacts.includes(GOOGLE_SCOPES.contacts));
  check("contacts never asks to read or send mail", !contacts.includes(GOOGLE_SCOPES.gmailRead) && !contacts.includes(GOOGLE_SCOPES.gmailSend), contacts.join(" "));
  check("incremental consent is on", new URL(contactsUrl).searchParams.get("include_granted_scopes") === "true");
  check("a refresh token is still requested", new URL(contactsUrl).searchParams.get("access_type") === "offline");
  const send = scopesOf(buildGmailAuthUrl("state-send", "send"));
  check("send asks for gmail.send without gmail.readonly", send.includes(GOOGLE_SCOPES.gmailSend) && !send.includes(GOOGLE_SCOPES.gmailRead));

  console.log("Stored grants");
  await cleanup();
  await ensureUserSettings(USER);
  const created = await upsertGmailConnection(USER, { access_token: "at1", refresh_token: "rt1", expires_in: 3600 }, "scope@example.test");
  check("a token response with no scope stores an empty grant", created?.scopes === "", JSON.stringify(created?.scopes));

  await upsertGmailConnection(USER, { access_token: "at2", scope: `openid ${GOOGLE_SCOPES.email} ${GOOGLE_SCOPES.contacts}`, expires_in: 3600 }, "scope@example.test");
  const widened = await upsertGmailConnection(USER, { access_token: "at3", scope: `openid ${GOOGLE_SCOPES.gmailRead}`, expires_in: 3600 }, "scope@example.test");
  check("a later grant adds to the stored scopes", hasScope(widened?.scopes, GOOGLE_SCOPES.contacts) && hasGmailReadScope(widened?.scopes), String(widened?.scopes));

  const refreshed = await upsertGmailConnection(USER, { access_token: "at4", expires_in: 3600 }, "scope@example.test");
  check("a refresh that omits scope keeps what was granted", refreshed?.scopes === widened?.scopes);

  console.log("Event connections read the grant");
  const grant = await findGmailGrant(USER);
  check("findGmailGrant returns the stored scopes", grant !== null && hasGmailReadScope(grant.scopes), JSON.stringify(grant));

  await cleanup();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll Gmail scope-storage checks passed.");
});
