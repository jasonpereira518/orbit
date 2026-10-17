/**
 * Microsoft Graph page and delta links are followed only when they are Graph's own.
 *
 * Pins: `fetchCalendarPage` (stored `pageToken` nextLink and `syncToken` deltaLink) and
 * `fetchCalendarWindow` (a page's `@odata.nextLink`) in src/lib/connectors/microsoft-calendar.ts,
 * `fetchContactsPage` in src/lib/connectors/microsoft-contacts.ts and `listOutlookMessagePage`'s
 * `skipToken` in src/lib/outlook.ts send no request — and so no bearer token — to a host other
 * than `https://graph.microsoft.com/v1.0/`. The cloud-notes reader's existing guard
 * (`listChanges` refusing a foreign OneDrive cursor) is the comparison case.
 *
 * Why: these links are full URLs that the sync scheduler and the Outlook scan persist (the
 * connection's `sync_cursor`, the scan job's stats) and replay with a fresh token, so a link
 * naming another host would hand that host the user's Microsoft access token. Graph never
 * does; this is defence in depth against a tampered response or a written-to cursor. The fix
 * moved `assertGraphUrl` from src/lib/cloud-files.ts to src/lib/graph-fetch.ts and calls it
 * before every stored or followed link.
 *
 * Run: npx tsx scripts/smoke-graph-nextlink-guard.ts
 */
import { fetchCalendarPage, fetchCalendarWindow } from "../src/lib/connectors/microsoft-calendar";
import { fetchContactsPage } from "../src/lib/connectors/microsoft-contacts";
import { listChanges } from "../src/lib/cloud-files";
import { listOutlookMessagePage } from "../src/lib/outlook";
import { checker } from "./smoke/check";
import { makeContact } from "./smoke/factories";
import { json, mockFetch, route, type Call } from "./smoke/http-mock";

const t = checker();
const TOKEN = "EwB4A8l6.users-graph-token-not-real";
const EVIL = "https://evil.example.com/v1.0/me/calendarView/delta?$skiptoken=x";
const OWNER = makeContact(0);

/** Did any request carry the user's token to a host other than Graph? */
function leaked(calls: Call[]): Call[] {
  return calls.filter((c) => new URL(c.url).hostname !== "graph.microsoft.com" && c.headers.authorization === `Bearer ${TOKEN}`);
}

async function attempt(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

async function main() {
  // The foreign host answers like Graph would, so the only thing that can stop the request
  // is a host check before it is sent.
  const http = mockFetch([
    route("GET", /^https:\/\/evil\.example\.com\//, () => json({ value: [] })),
    route("GET", /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/calendarView\?/, () =>
      json({ value: [], "@odata.nextLink": "https://evil.example.com/v1.0/me/calendarView?$skip=100" })
    ),
    route("GET", /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive/, () => json({ value: [] })),
  ]);
  try {
    console.log("The comparison: cloud-files refuses a foreign OneDrive cursor");
    {
      const before = http.calls.length;
      const err = await attempt(() => listChanges({ token: TOKEN }, "microsoft", "https://evil.example.com/v1.0/me/drive/root/delta?token=x"));
      t.check("listChanges throws 'Bad OneDrive cursor' and sends nothing", err instanceof Error && err.message === "Bad OneDrive cursor" && http.calls.length === before);
    }

    console.log("\ncalendar delta: a stored nextLink (cursor.pageToken) on a foreign host");
    {
      const before = http.calls.length;
      await attempt(() => fetchCalendarPage({ accessToken: TOKEN, cursor: { pageToken: EVIL }, ownerEmail: OWNER.email }));
      const sent = leaked(http.calls.slice(before));
      t.check("fetchCalendarPage sends no bearer token to a non-Graph nextLink host", sent.length === 0, sent.map((c) => c.url).join(", "));
    }

    console.log("calendar delta: a stored deltaLink (cursor.syncToken) on a foreign host");
    {
      const before = http.calls.length;
      await attempt(() => fetchCalendarPage({ accessToken: TOKEN, cursor: { syncToken: EVIL.replace("skiptoken", "deltatoken") }, ownerEmail: OWNER.email }));
      const sent = leaked(http.calls.slice(before));
      t.check("fetchCalendarPage sends no bearer token to a non-Graph deltaLink host", sent.length === 0, sent.map((c) => c.url).join(", "));
    }

    console.log("calendar window: a page's own @odata.nextLink on a foreign host");
    {
      const before = http.calls.length;
      await attempt(() => fetchCalendarWindow({ accessToken: TOKEN, from: new Date(), to: new Date(), maxPages: 2 }));
      const sent = leaked(http.calls.slice(before));
      t.check("the first, legitimate request went to Graph", http.calls[before]?.url.startsWith("https://graph.microsoft.com/") === true);
      t.check("fetchCalendarWindow does not follow a non-Graph @odata.nextLink", sent.length === 0, sent.map((c) => c.url).join(", "));
    }

    console.log("contacts: a stored nextLink on a foreign host");
    {
      const before = http.calls.length;
      await attempt(() => fetchContactsPage({ accessToken: TOKEN, cursor: { pageToken: "https://evil.example.com/v1.0/me/contacts?$skip=200" } }));
      const sent = leaked(http.calls.slice(before));
      t.check("fetchContactsPage sends no bearer token to a non-Graph nextLink host", sent.length === 0, sent.map((c) => c.url).join(", "));
    }

    console.log("outlook recruiter scan: a stored skipToken (nextLink) on a foreign host");
    {
      const before = http.calls.length;
      await attempt(() => listOutlookMessagePage(TOKEN, { query: "recruiter", skipToken: "https://evil.example.com/v1.0/me/messages?$skiptoken=x" }));
      const sent = leaked(http.calls.slice(before));
      t.check("listOutlookMessagePage sends no bearer token to a non-Graph skipToken host", sent.length === 0, sent.map((c) => c.url).join(", "));
    }
  } finally {
    http.restore();
  }

  t.done("graph nextLink guard");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
