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
import { encrypt } from "../src/lib/crypto";
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
  const contactsUrl = buildMicrosoftAuthUrl("state-contacts", "contacts");
  const contacts = scopesOf(contactsUrl);
  check("contacts asks for Contacts.Read", contacts.includes(MICROSOFT_SCOPES.contacts));
  check("contacts never asks to read mail or calendar", !contacts.includes(MICROSOFT_SCOPES.mail) && !contacts.includes(MICROSOFT_SCOPES.calendar), contacts.join(" "));
  check("identity scopes ride along", ["openid", "profile", "email", "offline_access", MICROSOFT_SCOPES.userRead].every((s) => contacts.includes(s)));
  check("consent is prompted for", new URL(contactsUrl).searchParams.get("prompt") === "consent");
  check("the state is passed through", new URL(contactsUrl).searchParams.get("state") === "state-contacts");
  const calendar = scopesOf(buildMicrosoftAuthUrl("s", "calendar"));
  check("calendar asks for Calendars.Read without mail or contacts", calendar.includes(MICROSOFT_SCOPES.calendar) && !calendar.includes(MICROSOFT_SCOPES.mail) && !calendar.includes(MICROSOFT_SCOPES.contacts));
  const mail = scopesOf(buildMicrosoftAuthUrl("s", "recruiter_scan"));
  check("the recruiter scan asks for Mail.Read without calendar", mail.includes(MICROSOFT_SCOPES.mail) && !mail.includes(MICROSOFT_SCOPES.calendar));
  const later = scopesOf(buildMicrosoftAuthUrl("s", "calendar", "openid Contacts.Read"));
  check("a later request names the earlier grant too, so the newest token covers both", later.includes(MICROSOFT_SCOPES.calendar) && later.includes(MICROSOFT_SCOPES.contacts) && !later.includes(MICROSOFT_SCOPES.mail));

  console.log("Stored grants");
  await cleanup();
  await ensureUserSettings(USER);
  const created = await upsertOutlookConnection(USER, { access_token: "at1", refresh_token: "rt1", expires_in: 3600 }, "scope@example.test");
  check("a token response with no scope stores an empty grant", created?.scopes === "", JSON.stringify(created?.scopes));
  check("…which is not calendar, contacts or mail", !hasCalendarScope(created?.scopes) && !hasContactsScope(created?.scopes) && !hasMailScope(created?.scopes));

  await upsertOutlookConnection(USER, { access_token: "at2", scope: "openid profile email User.Read Contacts.Read", expires_in: 3600 }, "scope@example.test");
  const widened = await upsertOutlookConnection(USER, { access_token: "at3", scope: "https://graph.microsoft.com/Calendars.Read openid", expires_in: 3600 }, "scope@example.test");
  check("contacts then calendar leaves both granted", hasContactsScope(widened?.scopes) && hasCalendarScope(widened?.scopes), String(widened?.scopes));
  check("…and not mail", !hasMailScope(widened?.scopes));
  check("openid is stored once", (widened?.scopes ?? "").split(" ").filter((s) => s === "openid").length === 1, String(widened?.scopes));

  const refreshedUpsert = await upsertOutlookConnection(USER, { access_token: "at4", expires_in: 3600 }, "scope@example.test");
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
    const row = await upsertOutlookConnection(USER, { access_token: "a", refresh_token: "r", scope: form, expires_in: 3600 }, "scope@example.test");
    check(`"${form}" is stored and read as calendar access`, hasCalendarScope(row?.scopes) && grantCovers("calendar", row?.scopes), String(row?.scopes));
  }
  await cleanup();
  await ensureUserSettings(USER);
  const lookalike = await upsertOutlookConnection(USER, { access_token: "a", refresh_token: "r", scope: "Calendars.ReadWrite", expires_in: 3600 }, "scope@example.test");
  check("a look-alike grant is not calendar access", !hasCalendarScope(lookalike?.scopes));

  console.log("Callback copy");
  const missing = describeOAuthReason("missing_scope", "Outlook", "recruiter_scan");
  check("a missing scope is an error, not a cancel", missing.cancelled === false);
  check("…worded for Microsoft, not Google", missing.message === "Microsoft didn’t grant mail access — reconnect and allow it", missing.message);
  check("…and for calendar", describeOAuthReason("missing_scope", "Outlook", "calendar").message === "Microsoft didn’t grant calendar access — reconnect and allow it");
  check("Google copy is unchanged for the same purpose name", describeOAuthReason("missing_scope", "Google", "calendar").message === "Google didn’t grant calendar access — reconnect and allow it");

  await cleanup();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll Outlook scope-storage checks passed.");
});
