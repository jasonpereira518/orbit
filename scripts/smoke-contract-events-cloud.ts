/**
 * Contract tests for two third-party readers that page through someone else's API on a cursor:
 * the Eventbrite connector (`src/lib/events/connectors/eventbrite.ts`) and the Drive/OneDrive
 * change feeds behind cloud notes (`src/lib/cloud-files.ts`), against mocked APIs.
 *
 * Payloads are shaped like the real ones: Eventbrite wraps text as `{ text, html }` and dates as
 * `{ timezone, local, utc }` and pages with `pagination.continuation` + `has_more_items` (NOT
 * page_count — see the module header); Drive `changes.list` returns `changes[].file` plus either
 * `nextPageToken` (more) or `newStartPageToken` (caught up); a OneDrive delta returns `value[]`
 * plus `@odata.nextLink` (more) or `@odata.deltaLink` (caught up), with deletions as `deleted`
 * facets and folders as `folder` facets.
 *
 * Pinned, beyond the happy paths:
 *   - Eventbrite: 401/403 are `EventbriteAuthError` (the sync marks the connection
 *     needs-reauth instead of backing off); a 5xx/429 is retried in-call; a 4xx is not; a
 *     non-JSON 200 rejects rather than reading as an empty page. A thrown network error is NOT
 *     retried in-call — it escapes on the first attempt and the scheduler's backoff retries the
 *     connection on a later pass. That is pinned as current behaviour (not a bug: no data is
 *     lost, the cursor is not advanced), with the one-call count as the evidence.
 *   - cloud-files: a dead grant (401) is `ReauthRequiredError` for both providers; a cursor that
 *     is not Graph's is refused before any request; an answer with no next cursor throws rather
 *     than storing an empty one. A 410 / 400 on a stored change cursor is
 *     `CloudCursorExpiredError`, the signal to start over — what the scan then does with it is
 *     `scripts/smoke-cloud-notes-dead-cursor.ts`.
 *
 * Retries here use real (short) sleeps: exactly one Eventbrite retry (~0.3–0.55 s) is exercised.
 *
 * Run: npx tsx scripts/smoke-contract-events-cloud.ts
 */
import { CloudCursorExpiredError, listChanges, listRecentFiles } from "../src/lib/cloud-files";
import { ReauthRequiredError } from "../src/lib/errors";
import {
  EventbriteAuthError,
  listEventAttendees,
  listOrganizationEvents,
  listOrganizations,
} from "../src/lib/events/connectors/eventbrite";
import { checker } from "./smoke/check";
import { makeContact } from "./smoke/factories";
import { json, mockFetch, networkError, notJson, route, status } from "./smoke/http-mock";

const t = checker();
const EB_TOKEN = "EBTESTTOKENNOTREAL";
const CLOUD_TOKEN = "test-cloud-token-not-real";
const GRAPH = "https://graph.microsoft.com/v1.0";
const DOC_MIME = "application/vnd.google-apps.document";
const deps = { fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init) };

function ebEvent(n: number, over: Record<string, unknown> = {}) {
  return {
    name: { text: `Founders Breakfast #${n}`, html: `Founders Breakfast #${n}` },
    description: { text: "Coffee and intros.", html: "<p>Coffee and intros.</p>" },
    id: `70000000000${n}`,
    url: `https://www.eventbrite.com/e/founders-breakfast-tickets-70000000000${n}`,
    start: { timezone: "America/New_York", local: "2026-11-02T08:00:00", utc: "2026-11-02T13:00:00Z" },
    end: { timezone: "America/New_York", local: "2026-11-02T10:00:00", utc: "2026-11-02T15:00:00Z" },
    organization_id: "123456789",
    status: "live",
    venue: { name: "The Hall", address: { city: "New York", country: "US" } },
    logo: { url: "https://img.evbuc.com/thumb.jpg", original: { url: "https://img.evbuc.com/full.jpg" } },
    ...over,
  };
}

function ebAttendee(n: number, over: Record<string, unknown> = {}) {
  const c = makeContact(n);
  return {
    id: `900000000${n}`,
    event_id: "700000000001",
    order_id: `8000${n}`,
    cancelled: false,
    refunded: false,
    status: "Attending",
    profile: { name: c.fullName, email: c.email, company: c.company, job_title: c.title, cell_phone: c.phone },
    ...over,
  };
}

async function main() {
  console.log("Eventbrite — organizations, events, attendees");
  {
    const http = mockFetch([
      route("GET", /\/users\/me\/organizations\//, () =>
        json({
          organizations: [{ _type: "organization", id: "123456789", name: "Orbit Test Org", vertical: "default", image_id: null }, { id: "", name: "no id" }],
          pagination: { object_count: 2, page_number: 1, page_size: 50, page_count: 1, has_more_items: false },
        })
      ),
      route("GET", /\/organizations\/123456789\/events\//, (call) => {
        const cont = new URL(call.url).searchParams.get("continuation");
        if (!cont) return json({ pagination: { object_count: 3, continuation: "eyJwYWdlIjogMn0", has_more_items: true }, events: [ebEvent(1), ebEvent(2, { name: null })] });
        return json({ pagination: { object_count: 3, has_more_items: false }, events: [ebEvent(3, { logo: null, venue: null })] });
      }),
      route("GET", /\/events\/700000000001\/attendees\//, () =>
        json({
          pagination: { object_count: 4, has_more_items: false, page_count: 1 },
          attendees: [ebAttendee(0), ebAttendee(1, { cancelled: true }), ebAttendee(2, { refunded: true }), ebAttendee(3, { profile: {} })],
        })
      ),
    ]);
    try {
      const orgs = await listOrganizations(EB_TOKEN, deps);
      t.check("an org without an id is dropped", orgs.length === 1 && orgs[0].id === "123456789" && orgs[0].name === "Orbit Test Org");
      t.check("the bearer and JSON accept headers are sent", http.calls[0].headers.authorization === `Bearer ${EB_TOKEN}` && http.calls[0].headers.accept === "application/json");

      const p1 = await listOrganizationEvents(EB_TOKEN, "123456789", null, deps);
      const sent = new URL(http.calls[1].url);
      t.check("events are asked for with venue+logo expanded, newest first", sent.searchParams.get("expand") === "venue,logo" && sent.searchParams.get("order_by") === "start_desc" && !sent.searchParams.has("continuation"));
      t.check("an event with no name is dropped", p1.items.length === 1);
      const e = p1.items[0];
      t.check("{text,html} and {utc} wrappers are unwrapped", e.title === "Founders Breakfast #1" && e.startsAt?.toISOString() === "2026-11-02T13:00:00.000Z" && e.timezone === "America/New_York");
      t.check("the full-size logo wins over the thumbnail; venue and city read", e.coverImageUrl === "https://img.evbuc.com/full.jpg" && e.venue === "The Hall" && e.city === "New York");
      t.check("has_more_items + continuation is the next cursor", p1.nextCursor === "eyJwYWdlIjogMn0");
      const p2 = await listOrganizationEvents(EB_TOKEN, "123456789", p1.nextCursor, deps);
      t.check("the continuation is sent back", new URL(http.calls[2].url).searchParams.get("continuation") === "eyJwYWdlIjogMn0");
      t.check("the last page has no cursor; a null logo/venue reads as null", p2.nextCursor === null && p2.items[0].coverImageUrl === null && p2.items[0].venue === null);

      const att = await listEventAttendees(EB_TOKEN, "700000000001", null, deps);
      t.check("cancelled, refunded and profile-less attendees are dropped", att.items.length === 1, String(att.items.length));
      t.check("the attendee profile maps", att.items[0].email === makeContact(0).email && att.items[0].title === makeContact(0).title && att.items[0].phone === makeContact(0).phone);
    } finally {
      http.restore();
    }
  }

  console.log("Eventbrite — failures");
  for (const code of [401, 403]) {
    const http = mockFetch([route("GET", /\/users\/me\/organizations\//, () => status(code, { status_code: code, error: "INVALID_AUTH", error_description: "The OAuth token you provided was invalid." }))]);
    try {
      await t.rejects(`${code} is EventbriteAuthError (a reconnect, not a backoff)`, () => listOrganizations(EB_TOKEN, deps), (e) => e instanceof EventbriteAuthError);
      t.check(`…after one call`, http.calls.length === 1);
    } finally {
      http.restore();
    }
  }
  {
    const http = mockFetch([route("GET", /\/events\//, () => status(404, { status_code: 404, error: "NOT_FOUND", error_description: "The event you requested does not exist." }))]);
    try {
      await t.rejects("a 404 is not retried and names the status", () => listEventAttendees(EB_TOKEN, "1", null, deps), (e) => e instanceof Error && e.message === "Eventbrite returned 404");
      t.check("…one call", http.calls.length === 1);
    } finally {
      http.restore();
    }
  }
  {
    let n = 0;
    const http = mockFetch([
      route("GET", /\/organizations\/1\/events\//, () => (n++ === 0 ? status(503, "<html>Service Unavailable</html>") : json({ events: [ebEvent(1)], pagination: { has_more_items: false } }))),
    ]);
    try {
      const page = await listOrganizationEvents(EB_TOKEN, "1", null, deps);
      t.check("a 503 then 200 is retried and succeeds", page.items.length === 1 && http.calls.length === 2);
    } finally {
      http.restore();
    }
  }
  {
    const http = mockFetch([route("GET", /\/organizations\/1\/events\//, networkError)]);
    try {
      await t.rejects("a network error rejects", () => listOrganizationEvents(EB_TOKEN, "1", null, deps));
      t.check("…on the first attempt (not retried in-call; the scheduler backs off)", http.calls.length === 1, String(http.calls.length));
    } finally {
      http.restore();
    }
  }
  {
    const http = mockFetch([route("GET", /\/organizations\/1\/events\//, () => notJson())]);
    try {
      await t.rejects("a non-JSON 200 rejects rather than reading as an empty page", () => listOrganizationEvents(EB_TOKEN, "1", null, deps));
    } finally {
      http.restore();
    }
  }
  {
    const http = mockFetch([route("GET", /\/organizations\/1\/events\//, () => json({ events: { id: "1" } }))]);
    try {
      const page = await listOrganizationEvents(EB_TOKEN, "1", null, deps);
      t.check("`events` not an array and no pagination reads as an empty last page", page.items.length === 0 && page.nextCursor === null);
    } finally {
      http.restore();
    }
  }

  console.log("\nDrive changes.list");
  {
    const docFile = (id: string, name: string) => ({ kind: "drive#file", id, name, mimeType: DOC_MIME, modifiedTime: "2026-10-16T10:00:00.000Z", webViewLink: `https://docs.google.com/document/d/${id}/edit`, trashed: false });
    const http = mockFetch([
      route("GET", /drive\/v3\/changes\?pageToken=p1/, () =>
        json({
          kind: "drive#changeList",
          nextPageToken: "p2",
          changes: [
            { kind: "drive#change", changeType: "file", fileId: "d1", removed: false, file: docFile("d1", "1:1 Ada notes") },
            { kind: "drive#change", changeType: "file", fileId: "d2", removed: true },
            { kind: "drive#change", changeType: "file", fileId: "s1", removed: false, file: { ...docFile("s1", "Budget"), mimeType: "application/vnd.google-apps.spreadsheet" } },
            { kind: "drive#change", changeType: "file", fileId: "t1", removed: false, file: { ...docFile("t1", "Old"), trashed: true } },
          ],
        })
      ),
      route("GET", /drive\/v3\/changes\?pageToken=p2/, () => json({ kind: "drive#changeList", newStartPageToken: "p9", changes: [] })),
      route("GET", /drive\/v3\/changes\?pageToken=bad/, () =>
        status(400, { error: { code: 400, message: "Invalid Value", errors: [{ domain: "global", reason: "invalid", message: "Invalid Value", locationType: "parameter", location: "pageToken" }] } })
      ),
      route("GET", /drive\/v3\/changes\?pageToken=revoked/, () => status(401, { error: { code: 401, status: "UNAUTHENTICATED" } })),
      route("GET", /drive\/v3\/changes\?pageToken=html/, () => notJson()),
      route("GET", /drive\/v3\/changes\?pageToken=nocursor/, () => json({ changes: [] })),
    ]);
    try {
      const ctx = { token: CLOUD_TOKEN };
      const a = await listChanges(ctx, "google", "p1");
      t.check("only live Google Docs survive (removed, sheets, trashed dropped)", a.files.length === 1 && a.files[0].id === "d1" && a.files[0].webUrl?.includes("/document/d/d1/") === true);
      t.check("nextPageToken → not done", a.cursor === "p2" && !a.done);
      const b = await listChanges(ctx, "google", "p2");
      t.check("newStartPageToken → done, with the from-now-on cursor", b.cursor === "p9" && b.done);
      await t.rejects("an invalid page token (400) is CloudCursorExpiredError, so the scan starts over", () => listChanges(ctx, "google", "bad"), (e) => e instanceof CloudCursorExpiredError);
      await t.rejects("a 401 is ReauthRequiredError", () => listChanges(ctx, "google", "revoked"), (e) => e instanceof ReauthRequiredError);
      await t.rejects("an HTML 200 rejects", () => listChanges(ctx, "google", "html"));
      await t.rejects("no next cursor at all throws rather than storing an empty one", () => listChanges(ctx, "google", "nocursor"), (e) => e instanceof Error && /no next cursor/.test(e.message));
    } finally {
      http.restore();
    }
  }

  console.log("OneDrive delta");
  {
    const item = (id: string, name: string, over: Record<string, unknown> = {}) => ({
      "@odata.type": "#microsoft.graph.driveItem",
      id,
      name,
      size: 18_000,
      lastModifiedDateTime: "2026-10-16T10:00:00Z",
      webUrl: `https://contoso-my.sharepoint.com/personal/x/Documents/${encodeURIComponent(name)}`,
      file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", hashes: {} },
      parentReference: { driveId: "b!test", driveType: "business", path: "/drive/root:" },
      ...over,
    });
    const page1 = `${GRAPH}/me/drive/root/delta?token=c1`;
    const page2 = `${GRAPH}/me/drive/root/delta?token=c2`;
    const dead = `${GRAPH}/me/drive/root/delta?token=expired`;
    const http = mockFetch([
      route("GET", page1, () =>
        json({
          value: [
            item("A1", "Standup notes.docx"),
            item("A2", "Gone.docx", { deleted: { state: "deleted" } }),
            item("A3", "Photos", { file: undefined, folder: { childCount: 3 } }),
            item("A4", "deck.pptx"),
            item("A5", "huge.docx", { size: 50 * 1024 * 1024 }),
            item("A6", "Zoom transcript.vtt", { file: { mimeType: "text/vtt" } }),
          ],
          "@odata.nextLink": page2,
        })
      ),
      route("GET", page2, () => json({ value: [], "@odata.deltaLink": `${GRAPH}/me/drive/root/delta?token=c3` })),
      route("GET", dead, () =>
        status(410, { error: { code: "resyncRequired", message: "Resync required. Replace any local items with the server's version (including deletes) if you're sure that the service was up to date with your local changes when you last sync'd." } })
      ),
      route("GET", /\/me\/drive\/recent/, () => status(401, { error: { code: "InvalidAuthenticationToken", message: "Access token has expired or is not yet valid." } })),
    ]);
    try {
      const ctx = { token: CLOUD_TOKEN };
      const a = await listChanges(ctx, "microsoft", page1);
      t.check("readable, live, small files survive (deleted, folder, .pptx, >10 MB dropped)", a.files.map((f) => f.id).join(",") === "A1,A6", a.files.map((f) => f.id).join(","));
      t.check("nextLink → not done", a.cursor === page2 && !a.done);
      const b = await listChanges(ctx, "microsoft", page2);
      t.check("deltaLink → done", b.done && b.cursor.endsWith("token=c3"));
      await t.rejects("a 410 resyncRequired on the stored delta is CloudCursorExpiredError, so the scan starts over", () => listChanges(ctx, "microsoft", dead), (e) =>
        e instanceof CloudCursorExpiredError
      );
      const before = http.calls.length;
      await t.rejects("a cursor that is not Graph's is refused", () => listChanges(ctx, "microsoft", "https://evil.example.com/delta"), (e) => e instanceof Error && e.message === "Bad OneDrive cursor");
      t.check("…before any request is sent", http.calls.length === before);
      await t.rejects("a 401 is ReauthRequiredError", () => listRecentFiles(ctx, "microsoft"), (e) => e instanceof ReauthRequiredError);
    } finally {
      http.restore();
    }
  }

  t.done("events + cloud-files contract");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
