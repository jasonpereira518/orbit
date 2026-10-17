/**
 * Contract tests for the Gmail REST reads in `src/lib/gmail.ts`, against a mocked Gmail.
 *
 * Every payload below is shaped like the real API's (`users.messages.list`, `messages.get`
 * with `format=full` and `format=metadata`, `threads.get`, People `connections.list`): ids as
 * hex strings, `internalDate` as a millisecond STRING, bodies as base64url in nested MIME
 * parts. The parsers walk those shapes by hand, so a field read from the wrong level returns
 * an empty string rather than failing — which is why the happy paths are pinned field by field.
 *
 * The failure half pins what each reader does with a 404, a 500, a proxy's HTML page served
 * with a 200, and a JSON body that is missing the fields it expected. The per-message readers
 * deliberately drop a message they cannot read (one deleted message must not sink a page);
 * the list and contacts readers throw, because a page they cannot read is a page they would
 * otherwise step over. A 401 is the one status that must not be treated as "message gone" —
 * `fetchGmailHeaders` is pinned here; the message, link and thread reads are pinned in
 * `scripts/smoke-gmail-401-reauth.ts`.
 *
 * No network: `globalThis.fetch` is the http-mock, and an unmatched request throws.
 *
 * Run: npx tsx scripts/smoke-contract-gmail.ts
 */
import { ReauthRequiredError } from "../src/lib/errors";
import {
  fetchGmailHeaders,
  fetchGmailMessageLinks,
  fetchGmailMessages,
  fetchGmailThread,
  fetchGooglePeopleContacts,
  listGmailMessagePage,
} from "../src/lib/gmail";
import { checker } from "./smoke/check";
import { makeContact } from "./smoke/factories";
import { json, mockFetch, notJson, route, status, type Call } from "./smoke/http-mock";

const t = checker();
const TOKEN = "ya29.test-access-token-not-real";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

const ADA = makeContact(0);
const GRACE = makeContact(1);

/** A `messages.get?format=full` body, the way Gmail returns a multipart/alternative mail. */
function fullMessage(id: string, over: { text?: string; html?: string; internalDate?: string } = {}) {
  const text = over.text ?? `Hi Ada,\n\nWe have an open role at ${GRACE.company}. Details: https://jobs.example.com/r/42\n\nGrace`;
  const html =
    over.html ??
    `<html><body><p>Hi Ada,</p><p>RSVP <a href="https://lu.ma/event/evt-test123">here</a></p><style>p{color:red}</style></body></html>`;
  return {
    id,
    threadId: `thr-${id}`,
    labelIds: ["INBOX", "CATEGORY_PERSONAL"],
    snippet: "Hi Ada, We have an open role at",
    sizeEstimate: 5321,
    historyId: "998877",
    internalDate: over.internalDate ?? "1760000000000",
    payload: {
      partId: "",
      mimeType: "multipart/alternative",
      filename: "",
      headers: [
        { name: "Delivered-To", value: ADA.email },
        { name: "From", value: `${GRACE.fullName} <${GRACE.email}>` },
        { name: "To", value: ADA.email },
        { name: "Cc", value: "team@example.com" },
        { name: "Subject", value: `Role at ${GRACE.company}` },
        { name: "Date", value: "Thu, 9 Oct 2025 08:53:20 +0000" },
        { name: "List-Unsubscribe", value: "<mailto:unsub@example.com>" },
        { name: "Authentication-Results", value: "mx.google.com; dkim=pass header.i=@lu.ma; spf=pass" },
      ],
      body: { size: 0 },
      parts: [
        { partId: "0", mimeType: "text/plain", filename: "", headers: [], body: { size: text.length, data: b64(text) } },
        { partId: "1", mimeType: "text/html", filename: "", headers: [], body: { size: html.length, data: b64(html) } },
      ],
    },
  };
}

/** Google's real 401 body for an access token it no longer honours. */
const GOOGLE_401 = {
  error: {
    code: 401,
    message: "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
    errors: [{ message: "Invalid Credentials", domain: "global", reason: "authError", location: "Authorization", locationType: "header" }],
    status: "UNAUTHENTICATED",
  },
};

async function main() {
  console.log("messages.list — happy path");
  {
    const http = mockFetch([
      route("GET", /gmail\/v1\/users\/me\/messages\?/, () =>
        json({
          messages: [
            { id: "18c2f0a1b2c3d4e5", threadId: "18c2f0a1b2c3d4e5" },
            { id: "18c2f0a1b2c3d4e6", threadId: "18c2f0a1b2c3d4e5" },
          ],
          nextPageToken: "05423847193478561234",
          resultSizeEstimate: 201,
        })
      ),
    ]);
    try {
      const page = await listGmailMessagePage(TOKEN, { query: "from:me", pageToken: "prev-token", maxResults: 50 });
      t.check("both refs come back", page.messages.length === 2 && page.messages[1].id === "18c2f0a1b2c3d4e6");
      t.check("the page token is carried", page.nextPageToken === "05423847193478561234");
      const sent = new URL(http.calls[0].url);
      t.check(
        "query, page size and page token are on the wire",
        sent.searchParams.get("q") === "from:me" && sent.searchParams.get("maxResults") === "50" && sent.searchParams.get("pageToken") === "prev-token"
      );
      t.check("the bearer token is sent", http.calls[0].headers.authorization === `Bearer ${TOKEN}`);
    } finally {
      http.restore();
    }
  }

  console.log("messages.list — an empty mailbox omits `messages` entirely");
  {
    const http = mockFetch([route("GET", /gmail\/v1\/users\/me\/messages\?/, () => json({ resultSizeEstimate: 0 }))]);
    try {
      const page = await listGmailMessagePage(TOKEN, { query: "x" });
      t.check("no refs, no next page", page.messages.length === 0 && page.nextPageToken === null);
    } finally {
      http.restore();
    }
  }

  console.log("messages.list — failures throw rather than read as an empty page");
  for (const [label, reply] of [
    ["500", () => status(500, { error: { code: 500, message: "Backend Error", status: "INTERNAL" } })],
    ["404", () => status(404, { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } })],
  ] as const) {
    const http = mockFetch([route("GET", /gmail\/v1\/users\/me\/messages\?/, reply)]);
    try {
      await t.rejects(`${label} rejects with Gmail's words, not a crash`, () => listGmailMessagePage(TOKEN, { query: "x" }), (e) =>
        e instanceof Error && e.message.startsWith("Gmail list failed")
      );
    } finally {
      http.restore();
    }
  }
  {
    const http = mockFetch([route("GET", /gmail\/v1\/users\/me\/messages\?/, () => notJson())]);
    try {
      // A proxy's HTML page with a 200 is not a page of zero messages: stepping over it would
      // advance the scan's page token past mail nobody read.
      await t.rejects("an HTML 200 rejects instead of returning an empty page", () => listGmailMessagePage(TOKEN, { query: "x" }));
    } finally {
      http.restore();
    }
  }

  console.log("messages.get (format=full) — parsing");
  {
    const htmlOnly = {
      ...fullMessage("m-html"),
      payload: {
        mimeType: "text/html",
        headers: [{ name: "From", value: GRACE.email }],
        body: { size: 80, data: b64("<div><style>.x{}</style><b>Hello</b>   <i>there</i></div>") },
      },
    };
    const http = mockFetch([
      route("GET", /messages\/m-full\?format=full/, () => json(fullMessage("m-full"))),
      route("GET", /messages\/m-html\?format=full/, () => json(htmlOnly)),
      route("GET", /messages\/m-bare\?format=full/, () => json({ id: "m-bare" })),
    ]);
    try {
      const [full, html, bare] = await fetchGmailMessages(TOKEN, ["m-full", "m-html", "m-bare"], 1);
      t.check("three messages, in request order", full?.id === "m-full" && html?.id === "m-html" && bare?.id === "m-bare");
      t.check("headers are read case-insensitively", full.from === `${GRACE.fullName} <${GRACE.email}>` && full.subject === `Role at ${GRACE.company}`);
      t.check("internalDate (a string on the wire) becomes a number", full.internalDate === 1760000000000);
      t.check("the text/plain part wins over html", full.body.startsWith("Hi Ada,\n\nWe have an open role"), JSON.stringify(full.body.slice(0, 40)));
      t.check("List-Unsubscribe is carried for triage", full.listUnsubscribe === "<mailto:unsub@example.com>");
      t.check("an html-only body is stripped of tags and styles", html.body.trim() === "Hello there", JSON.stringify(html.body));
      t.check(
        "a message with no payload parses to empty fields, not a crash",
        bare.from === "" && bare.subject === "" && bare.body === "" && bare.internalDate === null && bare.threadId === ""
      );
    } finally {
      http.restore();
    }
  }
  {
    const long = "x".repeat(10_000);
    const http = mockFetch([route("GET", /messages\/m-long\?format=full/, () => json(fullMessage("m-long", { text: long })))]);
    try {
      const [msg] = await fetchGmailMessages(TOKEN, ["m-long"]);
      t.check("a long body is trimmed to 4000 chars", msg.body.length === 4000);
    } finally {
      http.restore();
    }
  }

  console.log("messages.get (format=full) — one unreadable message does not sink the rest");
  {
    const http = mockFetch([
      route("GET", /messages\/ok1\?/, () => json(fullMessage("ok1"))),
      route("GET", /messages\/gone\?/, () => status(404, { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } })),
      route("GET", /messages\/boom\?/, () => status(500, { error: { code: 500, message: "Backend Error" } })),
      route("GET", /messages\/html\?/, () => notJson()),
      route("GET", /messages\/ok2\?/, () => json(fullMessage("ok2"))),
    ]);
    try {
      const out = await fetchGmailMessages(TOKEN, ["ok1", "gone", "boom", "html", "ok2"]);
      t.check("404, 500 and an HTML 200 are dropped; the readable two survive", out.map((m) => m.id).join(",") === "ok1,ok2", out.map((m) => m.id).join(","));
      t.check("each id was asked for exactly once (500 is not a retry status)", http.calls.length === 5, String(http.calls.length));
    } finally {
      http.restore();
    }
  }

  console.log("messages.get — links for event discovery");
  {
    const http = mockFetch([route("GET", /messages\/m-links\?format=full/, () => json(fullMessage("m-links")))]);
    try {
      const [msg] = await fetchGmailMessageLinks(TOKEN, ["m-links"]);
      t.check("the href behind a button is collected", msg.links.includes("https://lu.ma/event/evt-test123"), msg.links.join(" "));
      t.check("a bare URL in the text part is collected", msg.links.includes("https://jobs.example.com/r/42"));
      t.check("the DKIM verdict is carried", msg.authenticationResults.includes("dkim=pass header.i=@lu.ma"));
      t.check("Cc is carried", msg.cc === "team@example.com");
    } finally {
      http.restore();
    }
  }
  {
    const http = mockFetch([
      route("GET", /messages\/a\?/, () => status(404)),
      route("GET", /messages\/b\?/, () => notJson()),
    ]);
    try {
      const out = await fetchGmailMessageLinks(TOKEN, ["a", "b"]);
      t.check("404 and HTML 200 drop the message rather than throw", out.length === 0);
    } finally {
      http.restore();
    }
  }

  console.log("messages.get (format=metadata) — headers");
  {
    const meta = (id: string) => {
      const m = fullMessage(id);
      return { id: m.id, threadId: m.threadId, snippet: m.snippet, internalDate: m.internalDate, payload: { headers: m.payload.headers } };
    };
    const http = mockFetch([
      route("GET", /messages\/h1\?format=metadata/, () => json(meta("h1"))),
      route("GET", /messages\/h2\?format=metadata/, () => status(404)),
      route("GET", /messages\/h3\?format=metadata/, () => notJson()),
    ]);
    try {
      const out = await fetchGmailHeaders(TOKEN, [
        { id: "h1", threadId: "t1" },
        { id: "h2", threadId: "t2" },
        { id: "h3", threadId: "t3" },
      ]);
      t.check("the readable header survives, the 404 and HTML 200 are dropped", out.length === 1 && out[0].id === "h1");
      t.check("the metadata fields asked for are on the URL", /metadataHeaders=List-Unsubscribe/.test(http.calls[0].url) && /metadataHeaders=Cc/.test(http.calls[0].url));
      t.check("threadId from the message wins over the ref", out[0].threadId === "thr-h1");
    } finally {
      http.restore();
    }
  }
  {
    const http = mockFetch([route("GET", /messages\/h1\?format=metadata/, () => status(401, GOOGLE_401))]);
    try {
      // The correct behaviour the other readers are measured against.
      await t.rejects("a 401 on headers is a reconnect, not an empty page", () => fetchGmailHeaders(TOKEN, [{ id: "h1", threadId: "t1" }]), (e) =>
        e instanceof ReauthRequiredError
      );
    } finally {
      http.restore();
    }
  }

  console.log("threads.get");
  {
    const thread = {
      id: "thr-9",
      historyId: "123",
      messages: [
        { ...fullMessage("m-late", { internalDate: "1760000005000" }), threadId: "thr-9" },
        { ...fullMessage("m-early", { internalDate: "1760000001000" }), threadId: "thr-9" },
      ],
    };
    const http = mockFetch([
      route("GET", /threads\/thr-9\?format=metadata/, () => json(thread)),
      route("GET", /threads\/thr-gone\?/, () => status(404)),
      route("GET", /threads\/thr-500\?/, () => status(500)),
      route("GET", /threads\/thr-html\?/, () => notJson()),
      route("GET", /threads\/thr-shape\?/, () => json({ id: "thr-shape", messages: "not-an-array" })),
    ]);
    try {
      const got = await fetchGmailThread(TOKEN, "thr-9");
      t.check("a thread comes back oldest first", got?.messages.map((m) => m.id).join(",") === "m-early,m-late", got?.messages.map((m) => m.id).join(","));
      t.check("each message keeps its sender", got?.messages[0].from.includes(GRACE.email) === true);
      t.check("404 → null", (await fetchGmailThread(TOKEN, "thr-gone")) === null);
      t.check("500 → null", (await fetchGmailThread(TOKEN, "thr-500")) === null);
      t.check("HTML 200 → null", (await fetchGmailThread(TOKEN, "thr-html")) === null);
      t.check("`messages` not an array → null", (await fetchGmailThread(TOKEN, "thr-shape")) === null);
    } finally {
      http.restore();
    }
  }

  console.log("People connections.list");
  {
    const person = (n: number, over: Record<string, unknown> = {}) => {
      const c = makeContact(n);
      return {
        resourceName: `people/c${1000 + n}`,
        etag: `%Eg${n}`,
        names: [{ displayName: c.fullName, givenName: c.firstName, familyName: c.lastName, metadata: { primary: true } }],
        emailAddresses: [{ value: c.email, metadata: { primary: true } }],
        organizations: [{ name: c.company, title: c.title }],
        phoneNumbers: [{ value: c.phone }],
        photos: [{ url: "https://lh3.googleusercontent.com/default", default: true }, { url: `https://lh3.googleusercontent.com/a/p${n}` }],
        ...over,
      };
    };
    const calls: Call[] = [];
    const http = mockFetch([
      route("GET", /people\/me\/connections\?/, (call) => {
        calls.push(call);
        const token = new URL(call.url).searchParams.get("pageToken");
        if (!token) return json({ connections: [person(0), person(1)], nextPageToken: "page-2", totalPeople: 3, totalItems: 3 });
        return json({ connections: [person(2), { resourceName: "people/c9", emailAddresses: [{ value: "nameless@example.com" }] }], totalPeople: 3 });
      }),
    ]);
    try {
      const people = await fetchGooglePeopleContacts(TOKEN);
      t.check("both pages are read", calls.length === 2 && new URL(calls[1].url).searchParams.get("pageToken") === "page-2");
      t.check("a nameless connection is dropped", people.length === 3, String(people.length));
      t.check("fields map from the People shape", people[0].fullName === ADA.fullName && people[0].email === ADA.email && people[0].company === ADA.company);
      t.check("the default (silhouette) photo is skipped", people[0].photoUrl === "https://lh3.googleusercontent.com/a/p0");
    } finally {
      http.restore();
    }
  }
  {
    const http = mockFetch([route("GET", /people\/me\/connections\?/, () => json({ totalPeople: 0 }))]);
    try {
      t.check("an empty address book omits `connections` and reads as []", (await fetchGooglePeopleContacts(TOKEN)).length === 0);
    } finally {
      http.restore();
    }
  }
  {
    const http = mockFetch([route("GET", /people\/me\/connections\?/, () => status(500, { error: { code: 500, status: "INTERNAL" } }))]);
    try {
      await t.rejects("a 500 throws instead of importing nobody", () => fetchGooglePeopleContacts(TOKEN), (e) =>
        e instanceof Error && e.message.startsWith("Google Contacts fetch failed")
      );
    } finally {
      http.restore();
    }
  }

  t.done("gmail contract");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
