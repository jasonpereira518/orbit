/**
 * The OAuth URL each Outlook entry point builds, and what the connection row stores afterwards.
 * Before this, every URL asked for Contacts, Calendars and Mail, and a token response with no
 * `scope` was stored as all of them — a grant the person never gave. Microsoft also echoes
 * scopes as short names, full URIs or any case, so what is stored must still read as granted.
 *
 * Run: npx tsx scripts/smoke-outlook-scope-storage.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

process.env.MICROSOFT_CLIENT_ID ||= "smoke-microsoft-client-id";
process.env.MICROSOFT_REDIRECT_URI ||= "http://localhost:3001/api/outlook/callback";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { outlookConnections, userSettings } from "../src/db/schema";
import {
  buildMicrosoftAuthUrl,
  getValidAccessToken,
  hasCalendarScope,
  hasContactsScope,
  hasMailScope,
  storeRefreshedOutlookToken,
  upsertOutlookConnection,
} from "../src/lib/outlook";
import { MICROSOFT_SCOPES, grantCovers } from "../src/lib/microsoft-scopes";
import { describeOAuthReason } from "../src/lib/errors";
import { decrypt, encrypt } from "../src/lib/crypto";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-outlook-scope-user";
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
  await db.delete(outlookConnections).where(eq(outlookConnections.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

async function stored() {
  const db = await getDb();
  return db.query.outlookConnections.findFirst({ where: eq(outlookConnections.userId, USER) });
}

const scopesOf = (url: string) => new URL(url).searchParams.get("scope")?.split(" ") ?? [];

run(async () => {
  console.log("Authorization URLs");
  const contactsUrl = buildMicrosoftAuthUrl("state-contacts", ["contacts"]);
  const contacts = scopesOf(contactsUrl);
  check("contacts asks for Contacts.Read", contacts.includes(MICROSOFT_SCOPES.contacts));
  check("contacts never asks to read mail or calendar", !contacts.includes(MICROSOFT_SCOPES.mail) && !contacts.includes(MICROSOFT_SCOPES.calendar), contacts.join(" "));
  check("identity scopes ride along", ["openid", "profile", "email", "offline_access", MICROSOFT_SCOPES.userRead].every((s) => contacts.includes(s)));
  check("consent is prompted for", new URL(contactsUrl).searchParams.get("prompt") === "consent");
  check("the state is passed through", new URL(contactsUrl).searchParams.get("state") === "state-contacts");
  const calendar = scopesOf(buildMicrosoftAuthUrl("s", ["calendar"]));
  check("calendar asks for Calendars.Read without mail or contacts", calendar.includes(MICROSOFT_SCOPES.calendar) && !calendar.includes(MICROSOFT_SCOPES.mail) && !calendar.includes(MICROSOFT_SCOPES.contacts));
  const mail = scopesOf(buildMicrosoftAuthUrl("s", ["recruiter_scan"]));
  check("the recruiter scan asks for Mail.Read without calendar", mail.includes(MICROSOFT_SCOPES.mail) && !mail.includes(MICROSOFT_SCOPES.calendar));
  const later = scopesOf(buildMicrosoftAuthUrl("s", ["calendar"], "openid Contacts.Read"));
  check("a later request names the earlier grant too, so the newest token covers both", later.includes(MICROSOFT_SCOPES.calendar) && later.includes(MICROSOFT_SCOPES.contacts) && !later.includes(MICROSOFT_SCOPES.mail));

  console.log("Stored grants");
  await cleanup();
  await ensureUserSettings(USER);
  const { row: created } = await upsertOutlookConnection(USER, { access_token: "at1", refresh_token: "rt1", expires_in: 3600 }, "scope@example.test");
  check("a token response with no scope stores an empty grant", created?.scopes === "", JSON.stringify(created?.scopes));
  check("…which is not calendar, contacts or mail", !hasCalendarScope(created?.scopes) && !hasContactsScope(created?.scopes) && !hasMailScope(created?.scopes));

  await upsertOutlookConnection(USER, { access_token: "at2", scope: "openid profile email User.Read Contacts.Read", expires_in: 3600 }, "scope@example.test");
  const { row: widened } = await upsertOutlookConnection(USER, { access_token: "at3", scope: "https://graph.microsoft.com/Calendars.Read openid", expires_in: 3600 }, "scope@example.test");
  check("contacts then calendar leaves both granted", hasContactsScope(widened?.scopes) && hasCalendarScope(widened?.scopes), String(widened?.scopes));
  check("…and not mail", !hasMailScope(widened?.scopes));
  check("openid is stored once", (widened?.scopes ?? "").split(" ").filter((s) => s === "openid").length === 1, String(widened?.scopes));

  const { row: refreshedUpsert } = await upsertOutlookConnection(USER, { access_token: "at4", expires_in: 3600 }, "scope@example.test");
  check("an upsert that omits scope keeps what was granted", refreshedUpsert?.scopes === widened?.scopes);

  console.log("A refresh never touches scopes");
  await storeRefreshedOutlookToken(USER, { access_token: "at5", expires_in: 3600, scope: "Mail.Read" });
  const afterRefresh = await stored();
  check("storeRefreshedOutlookToken leaves the stored grant alone", afterRefresh?.scopes === widened?.scopes, String(afterRefresh?.scopes));

  const realFetch = globalThis.fetch;
  process.env.MICROSOFT_CLIENT_SECRET ||= "smoke-secret";
  try {
    const db = await getDb();
    await db
      .update(outlookConnections)
      .set({ tokenExpiresAt: new Date(Date.now() - 1000), accessTokenEncrypted: encrypt("stale"), refreshTokenEncrypted: encrypt("rt-live") })
      .where(eq(outlookConnections.userId, USER));
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600, scope: "calendars.read" }), { status: 200 })) as typeof fetch;
    const token = await getValidAccessToken(USER);
    const afterExpiry = await stored();
    check("an expired token is refreshed", token === "fresh");
    check("the refresh response's scope does not replace the stored grant", afterExpiry?.scopes === widened?.scopes, String(afterExpiry?.scopes));
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("Every response form reads as calendar access");
  for (const form of ["Calendars.Read", "https://graph.microsoft.com/Calendars.Read", "calendars.read", "openid CALENDARS.READ"]) {
    await cleanup();
    await ensureUserSettings(USER);
    const { row } = await upsertOutlookConnection(USER, { access_token: "a", refresh_token: "r", scope: form, expires_in: 3600 }, "scope@example.test");
    check(`"${form}" is stored and read as calendar access`, hasCalendarScope(row?.scopes) && grantCovers("calendar", row?.scopes), String(row?.scopes));
  }
  await cleanup();
  await ensureUserSettings(USER);
  const { row: lookalike } = await upsertOutlookConnection(USER, { access_token: "a", refresh_token: "r", scope: "Calendars.ReadWrite", expires_in: 3600 }, "scope@example.test");
  check("a look-alike grant is not calendar access", !hasCalendarScope(lookalike?.scopes));

  console.log("Callback copy");
  const missing = describeOAuthReason("missing_scope", "Outlook", "recruiter_scan");
  check("a missing scope is an error, not a cancel", missing.cancelled === false);
  check("…worded for Microsoft, not Google", missing.message === "Microsoft didn’t grant mail access — reconnect and allow it", missing.message);
  check("…and for calendar", describeOAuthReason("missing_scope", "Outlook", "calendar").message === "Microsoft didn’t grant calendar access — reconnect and allow it");
  check("Google copy is unchanged for the same purpose name", describeOAuthReason("missing_scope", "Google", "calendar").message === "Google didn’t grant calendar access — reconnect and allow it");

  console.log("\narming calendar sync");
  await cleanup();
  await ensureUserSettings(USER);
  await upsertOutlookConnection(USER, { access_token: "at5", refresh_token: "rt5", scope: MICROSOFT_SCOPES.contacts, expires_in: 3600 }, "jo@outlook.test");
  check("a contacts-only connect is not queued for calendar sync", (await stored())?.nextSyncAt === null);
  await upsertOutlookConnection(USER, { access_token: "at6", scope: `${MICROSOFT_SCOPES.contacts} ${MICROSOFT_SCOPES.calendar}`, expires_in: 3600 }, "jo@outlook.test");
  check("granting calendar queues it", (await stored())?.nextSyncAt !== null);
  await upsertOutlookConnection(USER, { access_token: "at7", scope: MICROSOFT_SCOPES.mail, expires_in: 3600 }, "jo@outlook.test");
  check("a later mail-only connect leaves calendar queued", (await stored())?.nextSyncAt !== null);

  console.log("\nhealing a mistakenly-armed row");
  await cleanup();
  await ensureUserSettings(USER);
  await upsertOutlookConnection(USER, { access_token: "at12", refresh_token: "rt12", scope: MICROSOFT_SCOPES.contacts, expires_in: 3600 }, "jo@outlook.test");
  {
    // Simulates a row the old (pre-fix) code armed by mistake for a contacts-only grant.
    const db = await getDb();
    await db.update(outlookConnections).set({ nextSyncAt: new Date() }).where(eq(outlookConnections.userId, USER));
  }
  await upsertOutlookConnection(USER, { access_token: "at13", scope: MICROSOFT_SCOPES.contacts, expires_in: 3600 }, "jo@outlook.test");
  check("a contacts-only connect clears a next_sync_at the old code armed by mistake", (await stored())?.nextSyncAt === null);

  console.log("\nconnecting a different account");
  await cleanup();
  await ensureUserSettings(USER);
  await upsertOutlookConnection(USER, { access_token: "at8", refresh_token: "rt8", scope: `${MICROSOFT_SCOPES.contacts} ${MICROSOFT_SCOPES.calendar}`, expires_in: 3600 }, "jo@outlook.test");
  {
    const db = await getDb();
    await db
      .update(outlookConnections)
      .set({ syncCursor: { calendar: { syncToken: "old" } } })
      .where(eq(outlookConnections.userId, USER));
  }
  const switched = await upsertOutlookConnection(USER, { access_token: "at9", scope: MICROSOFT_SCOPES.contacts, expires_in: 3600 }, "someone-else@outlook.test");
  check("the switch is reported", switched.switchedFrom === "jo@outlook.test");
  const afterSwitch = await stored();
  check("the new account's email is stored", afterSwitch?.emailAddress === "someone-else@outlook.test");
  check("the old account's scopes are dropped", !hasCalendarScope(afterSwitch?.scopes));
  check("the old account's cursor is dropped", afterSwitch?.syncCursor === null);
  const sameAccount = await upsertOutlookConnection(USER, { access_token: "at10", scope: MICROSOFT_SCOPES.calendar, expires_in: 3600 }, "someone-else@outlook.test");
  check("the same account keeps its scopes", sameAccount.switchedFrom === null);
  const sameAccountDifferentCasing = await upsertOutlookConnection(USER, { access_token: "at11", scope: MICROSOFT_SCOPES.calendar, expires_in: 3600 }, " Someone-Else@Outlook.test ");
  check("case and spacing don't count as a switch", sameAccountDifferentCasing.switchedFrom === null);

  console.log("\nrefresh token on account switch");
  await cleanup();
  await ensureUserSettings(USER);
  await upsertOutlookConnection(USER, { access_token: "atRefreshA", refresh_token: "old-refresh-token", scope: MICROSOFT_SCOPES.contacts, expires_in: 3600 }, "jo@outlook.test");
  const switchNoRefresh = await upsertOutlookConnection(USER, { access_token: "atRefreshB", scope: MICROSOFT_SCOPES.contacts, expires_in: 3600 }, "someone-else@outlook.test");
  check("a switch is reported here too", switchNoRefresh.switchedFrom === "jo@outlook.test");
  check(
    "a switch with no new refresh token does not inherit the old account's",
    (await stored())?.refreshTokenEncrypted === null
  );

  await cleanup();
  await ensureUserSettings(USER);
  await upsertOutlookConnection(USER, { access_token: "atRefreshC", refresh_token: "still-good-refresh-token", scope: MICROSOFT_SCOPES.contacts, expires_in: 3600 }, "jo@outlook.test");
  const sameAccountNoRefresh = await upsertOutlookConnection(USER, { access_token: "atRefreshD", scope: MICROSOFT_SCOPES.contacts, expires_in: 3600 }, "jo@outlook.test");
  check("the same account is not reported as a switch", sameAccountNoRefresh.switchedFrom === null);
  const keptRow = await stored();
  check(
    "the same account with no new refresh token keeps the existing one",
    Boolean(keptRow?.refreshTokenEncrypted) && decrypt(keptRow!.refreshTokenEncrypted!) === "still-good-refresh-token"
  );

  await cleanup();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll Outlook scope-storage checks passed.");
});
