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
import {
  buildGmailAuthUrl,
  hasCalendarScope,
  hasGmailReadScope,
  upsertGmailConnection,
} from "../src/lib/gmail";
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

async function readRow() {
  const db = await getDb();
  return db.query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, USER) });
}

const scopesOf = (url: string) => new URL(url).searchParams.get("scope")?.split(" ") ?? [];

run(async () => {
  console.log("Authorization URLs");
  const contactsUrl = buildGmailAuthUrl("state-contacts", ["contacts"]);
  const contacts = scopesOf(contactsUrl);
  check("contacts asks for contacts.readonly", contacts.includes(GOOGLE_SCOPES.contacts));
  check("contacts never asks to read or send mail", !contacts.includes(GOOGLE_SCOPES.gmailRead) && !contacts.includes(GOOGLE_SCOPES.gmailSend), contacts.join(" "));
  check("incremental consent is on", new URL(contactsUrl).searchParams.get("include_granted_scopes") === "true");
  check("a refresh token is still requested", new URL(contactsUrl).searchParams.get("access_type") === "offline");
  const send = scopesOf(buildGmailAuthUrl("state-send", ["send"]));
  check("send asks for gmail.send without gmail.readonly", send.includes(GOOGLE_SCOPES.gmailSend) && !send.includes(GOOGLE_SCOPES.gmailRead));

  console.log("Stored grants");
  await cleanup();
  await ensureUserSettings(USER);
  const { row: created } = await upsertGmailConnection(USER, { access_token: "at1", refresh_token: "rt1", expires_in: 3600 }, "scope@example.test");
  check("a token response with no scope stores an empty grant", created?.scopes === "", JSON.stringify(created?.scopes));

  await upsertGmailConnection(USER, { access_token: "at2", scope: `openid ${GOOGLE_SCOPES.email} ${GOOGLE_SCOPES.contacts}`, expires_in: 3600 }, "scope@example.test");
  const { row: widened } = await upsertGmailConnection(USER, { access_token: "at3", scope: `openid ${GOOGLE_SCOPES.gmailRead}`, expires_in: 3600 }, "scope@example.test");
  check("a later grant adds to the stored scopes", hasScope(widened?.scopes, GOOGLE_SCOPES.contacts) && hasGmailReadScope(widened?.scopes), String(widened?.scopes));

  const { row: refreshed } = await upsertGmailConnection(USER, { access_token: "at4", expires_in: 3600 }, "scope@example.test");
  check("a refresh that omits scope keeps what was granted", refreshed?.scopes === widened?.scopes);

  console.log("Event connections read the grant");
  const grant = await findGmailGrant(USER);
  check("findGmailGrant returns the stored scopes", grant !== null && hasGmailReadScope(grant.scopes), JSON.stringify(grant));

  console.log("\narming calendar sync");
  await cleanup();
  await ensureUserSettings(USER);
  await upsertGmailConnection(USER, { access_token: "at5", refresh_token: "rt5", scope: GOOGLE_SCOPES.contacts, expires_in: 3600 }, "jo@gmail.com");
  check("a contacts-only connect is not queued for calendar sync", (await readRow())?.nextSyncAt === null);
  await upsertGmailConnection(USER, { access_token: "at6", scope: `${GOOGLE_SCOPES.contacts} ${GOOGLE_SCOPES.calendar}`, expires_in: 3600 }, "jo@gmail.com");
  check("granting calendar queues it", (await readRow())?.nextSyncAt !== null);
  await upsertGmailConnection(USER, { access_token: "at7", scope: GOOGLE_SCOPES.gmailRead, expires_in: 3600 }, "jo@gmail.com");
  check("a later mail-only connect leaves calendar queued", (await readRow())?.nextSyncAt !== null);

  console.log("\nconnecting a different account");
  await cleanup();
  await ensureUserSettings(USER);
  await upsertGmailConnection(USER, { access_token: "at8", refresh_token: "rt8", scope: `${GOOGLE_SCOPES.contacts} ${GOOGLE_SCOPES.calendar}`, expires_in: 3600 }, "jo@gmail.com");
  {
    const db = await getDb();
    await db
      .update(gmailConnections)
      .set({ syncCursor: { calendar: { syncToken: "old" } } })
      .where(eq(gmailConnections.userId, USER));
  }
  const switched = await upsertGmailConnection(USER, { access_token: "at9", scope: GOOGLE_SCOPES.contacts, expires_in: 3600 }, "someone-else@gmail.com");
  check("the switch is reported", switched.switchedFrom === "jo@gmail.com");
  const afterSwitch = await readRow();
  check("the new account's email is stored", afterSwitch?.emailAddress === "someone-else@gmail.com");
  check("the old account's scopes are dropped", !hasCalendarScope(afterSwitch?.scopes));
  check("the old account's cursor is dropped", afterSwitch?.syncCursor === null);
  const sameAccount = await upsertGmailConnection(USER, { access_token: "at10", scope: GOOGLE_SCOPES.calendar, expires_in: 3600 }, "someone-else@gmail.com");
  check("the same account keeps its scopes", sameAccount.switchedFrom === null);
  const sameAccountDifferentCasing = await upsertGmailConnection(USER, { access_token: "at11", scope: GOOGLE_SCOPES.calendar, expires_in: 3600 }, " Someone-Else@Gmail.com ");
  check("case and spacing don't count as a switch", sameAccountDifferentCasing.switchedFrom === null);

  await cleanup();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll Gmail scope-storage checks passed.");
});
