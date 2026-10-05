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
import { decrypt } from "../src/lib/crypto";
import { pauseSync } from "../src/lib/provider-connections";

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

  console.log("\nhealing a mistakenly-armed row");
  await cleanup();
  await ensureUserSettings(USER);
  await upsertGmailConnection(USER, { access_token: "at12", refresh_token: "rt12", scope: GOOGLE_SCOPES.contacts, expires_in: 3600 }, "jo@gmail.com");
  {
    // Simulates a row the old (pre-fix) code armed by mistake for a contacts-only grant.
    const db = await getDb();
    await db.update(gmailConnections).set({ nextSyncAt: new Date() }).where(eq(gmailConnections.userId, USER));
  }
  await upsertGmailConnection(USER, { access_token: "at13", scope: GOOGLE_SCOPES.contacts, expires_in: 3600 }, "jo@gmail.com");
  check("a contacts-only connect clears a next_sync_at the old code armed by mistake", (await readRow())?.nextSyncAt === null);

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

  console.log("\na paused calendar survives a same-account reconnect, not a switch");
  await cleanup();
  await ensureUserSettings(USER);
  await upsertGmailConnection(USER, { access_token: "atPause1", refresh_token: "rtPause1", scope: `${GOOGLE_SCOPES.contacts} ${GOOGLE_SCOPES.calendar}`, expires_in: 3600 }, "jo@gmail.com");
  await pauseSync("google", USER);
  const pausedBefore = await readRow();
  check(
    "paused before reconnecting",
    pausedBefore?.syncStatus === "paused" && pausedBefore?.nextSyncAt === null
  );
  await upsertGmailConnection(USER, { access_token: "atPause2", scope: `${GOOGLE_SCOPES.contacts} ${GOOGLE_SCOPES.calendar} ${GOOGLE_SCOPES.gmailRead}`, expires_in: 3600 }, "jo@gmail.com");
  const afterReconnect = await readRow();
  check(
    "a same-account reconnect with a calendar-covering grant does not re-arm it",
    afterReconnect?.nextSyncAt === null,
    String(afterReconnect?.nextSyncAt)
  );
  check("sync_status is still paused after the reconnect", afterReconnect?.syncStatus === "paused");
  const switchedWhilePaused = await upsertGmailConnection(USER, { access_token: "atPause3", scope: GOOGLE_SCOPES.calendar, expires_in: 3600 }, "different@gmail.com");
  check("switching accounts while paused is still reported as a switch", switchedWhilePaused.switchedFrom === "jo@gmail.com");
  const afterSwitchWhilePaused = await readRow();
  check("switching to a different account arms it, even though the old one was paused", afterSwitchWhilePaused?.nextSyncAt !== null);
  check("switching accounts clears the paused sync_status", afterSwitchWhilePaused?.syncStatus === null);

  console.log("\nrefresh token on account switch");
  await cleanup();
  await ensureUserSettings(USER);
  await upsertGmailConnection(USER, { access_token: "atRefreshA", refresh_token: "old-refresh-token", scope: GOOGLE_SCOPES.contacts, expires_in: 3600 }, "jo@gmail.com");
  const switchNoRefresh = await upsertGmailConnection(USER, { access_token: "atRefreshB", scope: GOOGLE_SCOPES.contacts, expires_in: 3600 }, "someone-else@gmail.com");
  check("a switch is reported here too", switchNoRefresh.switchedFrom === "jo@gmail.com");
  check(
    "a switch with no new refresh token does not inherit the old account's",
    (await readRow())?.refreshTokenEncrypted === null
  );

  await cleanup();
  await ensureUserSettings(USER);
  await upsertGmailConnection(USER, { access_token: "atRefreshC", refresh_token: "still-good-refresh-token", scope: GOOGLE_SCOPES.contacts, expires_in: 3600 }, "jo@gmail.com");
  const sameAccountNoRefresh = await upsertGmailConnection(USER, { access_token: "atRefreshD", scope: GOOGLE_SCOPES.contacts, expires_in: 3600 }, "jo@gmail.com");
  check("the same account is not reported as a switch", sameAccountNoRefresh.switchedFrom === null);
  const keptRow = await readRow();
  check(
    "the same account with no new refresh token keeps the existing one",
    Boolean(keptRow?.refreshTokenEncrypted) && decrypt(keptRow!.refreshTokenEncrypted!) === "still-good-refresh-token"
  );

  await cleanup();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll Gmail scope-storage checks passed.");
});
