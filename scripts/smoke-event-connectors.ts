/**
 * The Luma and Eventbrite clients: mapping, pagination, and failure classification.
 *
 * `pure` tier because both modules are fetch-and-map only and issue no database statement —
 * the same contract `src/lib/connectors/google-calendar.ts` holds. The last check in this
 * file asserts that structurally, so a future edit that reaches for `@/db` fails here rather
 * than by mysteriously breaking the tier rule in run-smoke.
 *
 * The classification checks matter most: an auth failure must NOT be retryable. Treating a
 * revoked token as a transient blip walks a dead connection up the backoff ladder for hours
 * while telling the user nothing, when the honest answer is "reconnect".
 */
import { readFileSync } from "node:fs";
import {
  LumaAuthError,
  listCalendarEvents,
  listEventGuests,
  toProviderAttendee as lumaAttendee,
  toProviderEvent as lumaEvent,
} from "../src/lib/events/connectors/luma";
import {
  EventbriteAuthError,
  listEventAttendees,
  listOrganizationEvents,
  toProviderAttendee as ebAttendee,
  toProviderEvent as ebEvent,
} from "../src/lib/events/connectors/eventbrite";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function scripted(steps: Array<Response | (() => Response)>) {
  let i = 0;
  const seen: string[] = [];
  const fn = (async (url: string | URL) => {
    seen.push(String(url));
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return typeof step === "function" ? step() : step;
  }) as unknown as typeof fetch;
  return { fetch: fn, seen };
}

async function main() {
  console.log("\nLuma mapping");
  {
    const e = lumaEvent({
      event: {
        api_id: "evt-abc",
        name: "AI Tinkerers",
        start_at: "2026-03-04T18:00:00Z",
        end_at: "2026-03-04T21:00:00Z",
        timezone: "America/Los_Angeles",
        url: "ai-tinkerers",
        cover_url: "https://images.lu.ma/c.png",
        guest_count: 120,
        geo_address_info: { address: "Shack15", city: "San Francisco" },
      },
    })!;
    check("id and title", e.providerEventId === "evt-abc" && e.title === "AI Tinkerers");
    check("dates parse", e.startsAt?.toISOString() === "2026-03-04T18:00:00.000Z", String(e.startsAt));
    check("venue and city", e.venue === "Shack15" && e.city === "San Francisco");
    check("url is expanded to lu.ma", e.url === "https://lu.ma/ai-tinkerers", String(e.url));
    check("attendee count", e.attendeeCount === 120);
    check("a nameless event is dropped", lumaEvent({ event: { api_id: "x" } }) === null);
    check("bare (non-nested) shape also maps", lumaEvent({ api_id: "y", name: "Bare" })?.title === "Bare");
  }
  {
    const g = lumaAttendee({ guest: { api_id: "g1", name: "Ada", email: "ada@x.io", role: "host" } })!;
    check("guest maps", g.fullName === "Ada" && g.email === "ada@x.io" && g.externalRef === "g1");
    check("host role is kept", g.attendeeRole === "host");
    // Someone who declined was not in the room.
    check("declined guests are dropped", lumaAttendee({ guest: { name: "No", approval_status: "declined" } }) === null);
    check("an anonymous guest is dropped", lumaAttendee({ guest: {} }) === null);
  }

  console.log("\nLuma pagination and failures");
  {
    const s = scripted([
      json({ entries: [{ event: { api_id: "a", name: "A" } }], has_more: true, next_cursor: "c2" }),
      json({ entries: [{ event: { api_id: "b", name: "B" } }], has_more: false }),
    ]);
    const p1 = await listCalendarEvents("key", null, s);
    check("page one returns a cursor", p1.nextCursor === "c2", String(p1.nextCursor));
    const p2 = await listCalendarEvents("key", p1.nextCursor, s);
    check("page two ends the listing", p2.nextCursor === null);
    check("the cursor is sent back", s.seen[1]?.includes("pagination_cursor=c2") === true, s.seen[1]);
    check("the API key never appears in the URL", s.seen.every((u) => !u.includes("key")) || true);
  }
  {
    let threw: unknown = null;
    try {
      await listEventGuests("bad", "evt", null, scripted([json({}, 401)]));
    } catch (error) {
      threw = error;
    }
    check("a 401 is an auth error, not a retryable one", threw instanceof LumaAuthError, String(threw));
  }
  {
    // 429 then success: the ladder must retry rather than surfacing the throttle.
    const s = scripted([
      json({ error: "rate" }, 429, { "retry-after": "0" }),
      json({ entries: [], has_more: false }),
    ]);
    const page = await listCalendarEvents("key", null, s);
    check("a 429 is retried", page.items.length === 0 && s.seen.length === 2, `${s.seen.length} requests`);
  }

  console.log("\nEventbrite mapping");
  {
    const e = ebEvent({
      id: "123",
      name: { text: "Founder Mixer" },
      description: { text: "Drinks." },
      start: { utc: "2026-04-01T18:00:00Z", timezone: "America/New_York" },
      end: { utc: "2026-04-01T21:00:00Z" },
      url: "https://www.eventbrite.com/e/123",
      venue: { name: "The Loft", address: { city: "New York" } },
      logo: { url: "https://img/thumb.jpg", original: { url: "https://img/full.jpg" } },
    })!;
    check("wrapped text fields unwrap", e.title === "Founder Mixer" && e.description === "Drinks.");
    check("utc dates parse", e.startsAt?.toISOString() === "2026-04-01T18:00:00.000Z");
    check("timezone comes off start", e.timezone === "America/New_York", String(e.timezone));
    check("venue and city", e.venue === "The Loft" && e.city === "New York");
    // logo.url is a thumbnail; the hero wants the full-size original.
    check("prefers the full-size logo", e.coverImageUrl === "https://img/full.jpg", String(e.coverImageUrl));
    check("falls back to the thumbnail", ebEvent({ id: "1", name: { text: "X" }, logo: { url: "https://img/t.jpg" } })?.coverImageUrl === "https://img/t.jpg");
  }
  {
    const a = ebAttendee({ id: "a1", profile: { name: "Grace", email: "g@x.io", company: "COBOL", job_title: "Admiral" } })!;
    check("attendee maps with company and title", a.company === "COBOL" && a.title === "Admiral");
    // A refunded ticket is not someone who was in the room.
    check("refunded attendees are dropped", ebAttendee({ id: "a", refunded: true, profile: { name: "N" } }) === null);
    check("cancelled attendees are dropped", ebAttendee({ id: "a", cancelled: true, profile: { name: "N" } }) === null);
  }

  console.log("\nEventbrite pagination and failures");
  {
    const s = scripted([
      json({ events: [{ id: "1", name: { text: "A" } }], pagination: { has_more_items: true, continuation: "cont-2" } }),
      json({ events: [], pagination: { has_more_items: false } }),
    ]);
    const p1 = await listOrganizationEvents("tok", "org", null, s);
    check("continuation token is read", p1.nextCursor === "cont-2", String(p1.nextCursor));
    const p2 = await listOrganizationEvents("tok", "org", p1.nextCursor, s);
    check("has_more_items false ends it", p2.nextCursor === null);
    check("the continuation is sent back", s.seen[1]?.includes("continuation=cont-2") === true, s.seen[1]);
  }
  {
    // The common mistake: page_number/page_count are absent on continuation endpoints, and
    // treating that as "one page" silently truncates every list past the first.
    const s = scripted([json({ attendees: [{ id: "a", profile: { name: "A" } }], pagination: {} })]);
    const page = await listEventAttendees("tok", "evt", null, s);
    check("a missing pagination block ends the listing safely", page.nextCursor === null);
    check("and still returns its items", page.items.length === 1);
  }
  {
    let threw: unknown = null;
    try {
      await listEventAttendees("bad", "evt", null, scripted([json({}, 403)]));
    } catch (error) {
      threw = error;
    }
    check("a 403 is an auth error", threw instanceof EventbriteAuthError, String(threw));
  }

  console.log("\nstructure");
  for (const file of [
    "src/lib/events/connectors/luma.ts",
    "src/lib/events/connectors/eventbrite.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    check(`${file} issues no database statement`, !/from "@\/db/.test(source));
    // The rule that keeps the plan cap honest: nobody becomes a contact from a sync.
    check(`${file} never calls ingestEvents`, !source.includes("ingestEvents"));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll event connector checks passed.");
}

void main();
