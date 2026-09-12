/**
 * Event page parsing and roster parsing.
 *
 * The fixtures are shaped like the real thing (Luma renders JSON-LD, Eventbrite leans on
 * OpenGraph, Partiful gives little more than a title) so that when one of them reshuffles
 * their markup, a failing assertion says so rather than events quietly arriving blank.
 *
 * ## The load-bearing negative, narrowed on purpose
 *
 * This file used to assert that `parseEventPage` returned NO people at all. That rule has been
 * deliberately narrowed to: only `performer` — the line-up a host published to advertise their
 * own event — and never a guest list.
 *
 * The narrowing is recorded here rather than done silently because the original assertion was
 * the guard, and deleting a guard should cost a paragraph. What still holds, and what the
 * checks below enforce, is the part that actually protects people: nothing reads RSVPs,
 * "who's going" widgets, guest counts, or ticket holders. A speaker is the host talking about
 * their own event; an attendee is someone who never agreed to be in a stranger's CRM.
 */
import { parseEventPage } from "../src/lib/events/parse-page";
import { resolveEventTitle } from "../src/lib/events/types";
import {
  parseRosterCsv,
  parseRosterText,
  peopleToAttendees,
  speakersToAttendees,
  MAX_ROSTER_ROWS,
} from "../src/lib/events/parse-roster";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const LUMA = `<!doctype html><html><head>
<title>AI Tinkerers SF · Luma</title>
<meta property="og:title" content="AI Tinkerers SF">
<meta property="og:image" content="https://images.lu.ma/cover.png">
<meta property="og:description" content="A night of demos.">
<meta name="theme-color" content="#7C3AED">
<link rel="canonical" href="https://lu.ma/ai-tinkerers-sf">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Event","name":"AI Tinkerers SF",
 "startDate":"2026-03-04T18:00:00-08:00","endDate":"2026-03-04T21:00:00-08:00",
 "location":{"@type":"Place","name":"Shack15","address":{"@type":"PostalAddress","addressLocality":"San Francisco"}},
 "organizer":{"@type":"Organization","name":"AI Tinkerers","url":"/org/ai-tinkerers"},
 "eventAttendanceMode":"https://schema.org/OfflineEventAttendanceMode",
 "performer":[{"@type":"Person","name":"Ada Lovelace","url":"https://www.linkedin.com/in/ada"},
              {"@type":"Person","name":"Grace Hopper","url":"https://grace.example.com"},
              {"@type":"Person","name":"Ada Lovelace"}],
 "image":"https://images.lu.ma/logo-small.png"}
</script></head><body>...</body></html>`;

const EVENTBRITE = `<!doctype html><html><head>
<meta property="og:title" content="Founder Mixer">
<meta property="og:image" content="https://img.evbuc.com/hero.jpg">
<meta property="og:url" content="https://www.eventbrite.com/e/founder-mixer-123">
</head><body></body></html>`;

/** A host that published a wall-clock time and no offset — the common, ambiguous case. */
const FLOATING_TIME = `<!doctype html><html><head>
<script type="application/ld+json">
{"@type":"Event","name":"Floating","startDate":"2026-03-04T18:00:00"}
</script></head><body></body></html>`;

const ONLINE = `<!doctype html><html><head>
<script type="application/ld+json">
{"@type":"Event","name":"Remote Standup","startDate":"2026-03-04T18:00:00Z",
 "eventAttendanceMode":"OnlineEventAttendanceMode","organizer":"Solo Organiser"}
</script></head><body></body></html>`;

/** The shape that must NOT produce people: a guest list, however it is dressed up. */
const GUEST_LIST = `<!doctype html><html><head>
<script type="application/ld+json">
{"@type":"Event","name":"Mixer","startDate":"2026-03-04T18:00:00Z",
 "attendee":[{"@type":"Person","name":"Should Not Appear"}],
 "attendees":[{"@type":"Person","name":"Nor This"}],
 "maximumAttendeeCapacity":300}
</script></head><body></body></html>`;

const PARTIFUL = `<!doctype html><html><head><title>Rooftop Thing</title></head><body></body></html>`;

const BROKEN_LD = `<!doctype html><html><head>
<meta property="og:title" content="Still Readable">
<script type="application/ld+json">{ this is not json }</script>
<script type="application/ld+json">{"@type":"Event","name":"From Graph","startDate":"2026-05-01T10:00:00Z"}</script>
</head><body></body></html>`;

const GRAPH = `<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebPage","name":"Not the event"},
  {"@type":"SocialEvent","name":"Nested Event","startDate":"2026-07-04T12:00:00Z"}]}
</script></head><body></body></html>`;

function main() {
  console.log("\nLuma-shaped page");
  {
    const d = parseEventPage(LUMA, "https://lu.ma/ai-tinkerers-sf");
    check("title", d.title === "AI Tinkerers SF", String(d.title));
    // JSON-LD wins for dates: OpenGraph has no date field at all.
    check("start date from JSON-LD", d.startsAt?.toISOString() === "2026-03-05T02:00:00.000Z", String(d.startsAt));
    check("end date", d.endsAt !== null);
    check("venue", d.venue === "Shack15", String(d.venue));
    check("city", d.city === "San Francisco", String(d.city));
    check("theme-color", d.themeColor === "#7C3AED", String(d.themeColor));
    check("canonical", d.canonicalUrl === "https://lu.ma/ai-tinkerers-sf", String(d.canonicalUrl));
    // og:image wins over JSON-LD image: the former is the host's chosen share graphic,
    // the latter is routinely a logo.
    check("og:image beats ld image", d.imageUrl === "https://images.lu.ma/cover.png", String(d.imageUrl));
    check("organizer name", d.organizerName === "AI Tinkerers", String(d.organizerName));
    // Hosts write organizer URLs relative more often than you would hope.
    check(
      "organizer url is absolutised",
      d.organizerUrl === "https://lu.ma/org/ai-tinkerers",
      String(d.organizerUrl)
    );
    check("attendance mode from a schema.org URL", d.attendanceMode === "offline", String(d.attendanceMode));
    check("the published offset is kept", d.timezone === "-08:00", String(d.timezone));
    check("speakers are read", d.speakers.length === 2, String(d.speakers.length));
    check(
      "a repeated speaker collapses",
      d.speakers.filter((x) => x.name === "Ada Lovelace").length === 1
    );
    check("speaker url is kept", d.speakers[0]?.url?.includes("/in/ada") === true);
  }

  console.log("\nthe line drawn at speakers");
  {
    const d = parseEventPage(GUEST_LIST, "https://example.com/e");
    // The narrowing was to `performer` ONLY. A guest list must stay invisible however the
    // host spells it, and no attendee-shaped field may exist on the result at all.
    check("no attendee/guest field is exposed", !("attendees" in d) && !("guests" in d) && !("attendee" in d));
    check("schema.org `attendee` produces no speakers", d.speakers.length === 0, String(d.speakers.length));
    check("capacity is not read", !("maximumAttendeeCapacity" in d) && !("capacity" in d));
  }

  console.log("\ntime zones");
  {
    const d = parseEventPage(FLOATING_TIME, "https://example.com/e");
    // The bug: `new Date("...T18:00:00")` reads as the RUNTIME's zone, so this assertion
    // used to pass in New York and fail on Vercel. Parsing as UTC makes it machine-independent.
    check(
      "an offset-less time parses identically everywhere",
      d.startsAt?.toISOString() === "2026-03-04T18:00:00.000Z",
      String(d.startsAt)
    );
    check("and is reported as zone-less rather than certain", d.timezone === null, String(d.timezone));
    check("which is recorded", d.warnings.includes("no-timezone"));
  }
  {
    const d = parseEventPage(ONLINE, "https://example.com/e");
    check("a bare enum name is understood", d.attendanceMode === "online", String(d.attendanceMode));
    check("Z is a stated zone", d.timezone === "Z", String(d.timezone));
    check("no no-timezone warning when stated", !d.warnings.includes("no-timezone"));
    check("a string organizer works", d.organizerName === "Solo Organiser", String(d.organizerName));
  }

  console.log("\nEventbrite-shaped page (OpenGraph only)");
  {
    const d = parseEventPage(EVENTBRITE, "https://www.eventbrite.com/e/founder-mixer-123?aff=x");
    check("title from og", d.title === "Founder Mixer", String(d.title));
    check("image from og", d.imageUrl === "https://img.evbuc.com/hero.jpg", String(d.imageUrl));
    check("canonical falls back to og:url", d.canonicalUrl?.includes("founder-mixer-123") === true);
    check("missing dates degrade to null", d.startsAt === null && d.endsAt === null);
    check("notes that no JSON-LD event was found", d.warnings.includes("no-jsonld-event"));
  }

  console.log("\nsparse and malformed pages");
  {
    const d = parseEventPage(PARTIFUL, "https://partiful.com/e/abc");
    check("falls back to <title>", d.title === "Rooftop Thing", String(d.title));
    check("everything else is null, not an exception", d.venue === null && d.imageUrl === null);
  }
  {
    const d = parseEventPage(BROKEN_LD, "https://example.com/e");
    // One malformed block must not discard a valid one, nor the OpenGraph beside it.
    check("a malformed JSON-LD block does not throw", true);
    check("it is recorded as a warning", d.warnings.includes("parse-failed:ld+json"));
    check("a later valid block is still read", d.title === "From Graph", String(d.title));
  }
  {
    const d = parseEventPage(GRAPH, "https://example.com/e");
    check("an event nested in @graph is found", d.title === "Nested Event", String(d.title));
  }
  {
    const d = parseEventPage(
      `<meta content="Reversed Order" property="og:title">`,
      "https://example.com/e"
    );
    check("meta attribute order does not matter", d.title === "Reversed Order", String(d.title));
  }
  {
    const d = parseEventPage(
      `<meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;Party&quot;">`,
      "https://example.com/e"
    );
    check("entities are decoded", d.title === `Tom & Jerry's "Party"`, String(d.title));
  }
  {
    const d = parseEventPage(`<meta name="theme-color" content="rebeccapurple">`, "https://e.com");
    // theme.ts can only clamp a hex; a named colour must fall through to the next rung.
    check("a non-hex theme-color is rejected", d.themeColor === null, String(d.themeColor));
  }

  console.log("\nroster parsing");
  {
    const r = parseRosterText(
      "Ada Lovelace <ada@analytical.io> — Engineer at Analytical\n" +
        "- Grace Hopper, COBOL Inc\n" +
        "Alan Turing\n" +
        "https://www.linkedin.com/in/kturing\n" +
        "@katherinej\n" +
        "Ada Lovelace <ada@analytical.io>\n" +
        "???\n"
    );
    check("parses five distinct people", r.attendees.length === 5, String(r.attendees.length));
    check("splits name / title / company", r.attendees[0]?.title === "Engineer" && r.attendees[0]?.company === "Analytical");
    check("strips list bullets", r.attendees[1]?.fullName === "Grace Hopper", String(r.attendees[1]?.fullName));
    check("picks up a bare LinkedIn URL", r.attendees[3]?.linkedinUrl?.includes("kturing") === true);
    check("picks up a bare @handle", r.attendees[4]?.xHandle === "katherinej", String(r.attendees[4]?.xHandle));
    check("collapses a repeated person", r.deduped === 1, String(r.deduped));
    // Separator debris must be counted as skipped, not become an attendee named "???".
    check("junk lines are skipped and counted", r.skipped === 1, String(r.skipped));
  }
  {
    const r = parseRosterText("Name\tRole\tCompany\nAda\tEngineer\tAnalytical");
    check("tab-separated columns are read", r.attendees.some((a) => a.fullName === "Ada"));
  }
  {
    const r = parseRosterCsv(
      "First Name,Last Name,Email,Company,Job Title\nAda,Lovelace,ada@x.io,Analytical,Engineer\n"
    );
    check("CSV joins split name columns", r.attendees[0]?.fullName === "Ada Lovelace", String(r.attendees[0]?.fullName));
    check("CSV maps header aliases", r.attendees[0]?.title === "Engineer" && r.attendees[0]?.company === "Analytical");
  }
  {
    const r = parseRosterCsv("Attendee Name,Email Address\nGrace Hopper,grace@navy.mil\n");
    check("alternative header aliases work", r.attendees[0]?.email === "grace@navy.mil");
  }
  {
    const rows = Array.from({ length: MAX_ROSTER_ROWS + 50 }, (_, i) => `Person ${i} <p${i}@x.io>`);
    const r = parseRosterText(rows.join("\n"));
    check("the row cap holds", r.attendees.length === MAX_ROSTER_ROWS, String(r.attendees.length));
  }

  console.log("\ntitle resolution");
  {
    // The regression: `createEvent` stores UNTITLED_EVENT when you add an event by pasting a
    // link alone. Enrichment then ran "existing title wins", the placeholder was truthy, and
    // the title fetched from the page lost to it — so pasting a link produced an event
    // permanently called "Untitled event".
    check("the placeholder loses to a fetched title", resolveEventTitle("Untitled event", "Founder Mixer") === "Founder Mixer");
    check("a real typed title still wins", resolveEventTitle("My Own Name", "Founder Mixer") === "My Own Name");
    check("a blank falls through to the page", resolveEventTitle(null, "Founder Mixer") === "Founder Mixer");
    check("whitespace counts as blank", resolveEventTitle("   ", "Founder Mixer") === "Founder Mixer");
    check("both missing falls back to the placeholder", resolveEventTitle(null, null) === "Untitled event");
    check("an unreadable page does not erase a typed title", resolveEventTitle("My Own Name", null) === "My Own Name");
  }

  console.log("\nspeakers as roster rows");
  {
    const rows = speakersToAttendees([
      { name: "Ada Lovelace", url: "https://www.linkedin.com/in/ada" },
      { name: "Katherine J", url: "https://x.com/@katherinej" },
      { name: "Grace Hopper", url: "https://grace.example.com" },
      { name: "Grace Hopper", url: null },
      { name: "Broken", url: "not a url" },
    ]);
    check("every speaker becomes a row", rows.length === 4, String(rows.length));
    check("all are marked as speakers", rows.every((r) => r.attendeeRole === "speaker"));
    check("a LinkedIn url is claimed", rows[0]?.linkedinUrl?.includes("/in/ada") === true);
    check("and keys on it", rows[0]?.identityKey === "li:https://www.linkedin.com/in/ada", String(rows[0]?.identityKey));
    check("an X url becomes a handle", rows[1]?.xHandle === "katherinej", String(rows[1]?.xHandle));
    // A personal homepage has no column that means "homepage"; dropping it beats filing it
    // under `linkedinUrl`, where every later consumer would read it as a LinkedIn profile.
    check("a homepage is dropped, not mis-filed", rows[2]?.linkedinUrl === null && rows[2]?.xHandle === null);
    check("and falls back to a name key", rows[2]?.identityKey === "nm:grace hopper", String(rows[2]?.identityKey));
    check("the same name twice collapses", rows.filter((r) => r.fullName === "Grace Hopper").length === 1);
    check("a malformed url costs the link, not the speaker", rows[3]?.fullName === "Broken", String(rows[3]?.fullName));
    check("no email is invented", rows.every((r) => r.email === null));
  }

  console.log("\nthe platform overlay: what a page publishes about people");
  {
    // A Luma page, in the shape Luma actually ships: JSON-LD in the head, and the real
    // article — the event, its hosts, its featured guests — as `__NEXT_DATA__` at the END of
    // the body. The padding is not decoration: it is what proves the byte cap was raised,
    // because a truncated JSON blob parses as nothing at all.
    const nextData = {
      props: {
        pageProps: {
          initialData: {
            data: {
              event: {
                api_id: "evt-6mLuOvNxaIcg",
                name: "AI Tinkerers SF",
                timezone: "America/Los_Angeles",
                guest_count: 214,
              },
              calendar: { name: "AI Tinkerers" },
              hosts: [
                {
                  api_id: "usr-host1",
                  name: "Ada Lovelace",
                  linkedin_handle: "ada-lovelace",
                  twitter_handle: "@adal",
                  bio_short: "Building things",
                },
                { api_id: "usr-host2", name: "Grace Hopper" },
              ],
              featured_guests: [
                { api_id: "usr-g1", name: "Katherine Johnson", linkedin_handle: "in/kjohnson" },
                { api_id: "usr-g2", name: "Margaret Hamilton" },
              ],
            },
          },
        },
      },
    };
    const lumaPage =
      `<html><head><title>AI Tinkerers SF</title>` +
      `<meta property="og:title" content="AI Tinkerers SF">` +
      `</head><body><div>${"padding ".repeat(2000)}</div>` +
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>` +
      `</body></html>`;

    const details = parseEventPage(lumaPage, "https://lu.ma/ai-tinkerers");
    check("the platform is recognised", details.platform === "luma", String(details.platform));
    // JSON-LD has no id at all; this is what makes three sources agree on one event.
    check("the platform's own event id is read", details.providerEventId === "evt-6mLuOvNxaIcg", String(details.providerEventId));
    // An offset is only right half the year; a zone name is right always.
    check("an IANA zone beats an offset", details.timezone === "America/Los_Angeles", String(details.timezone));
    check("the hosts are named", details.hosts.length === 2, String(details.hosts.length));
    check("with LinkedIn normalised to a URL", details.hosts[0]?.linkedinUrl === "https://www.linkedin.com/in/ada-lovelace", String(details.hosts[0]?.linkedinUrl));
    check("and the @ stripped off X", details.hosts[0]?.xHandle === "adal", String(details.hosts[0]?.xHandle));
    check("featured guests come through", details.featuredGuests.length === 2, String(details.featuredGuests.length));
    check("an `in/` prefix is normalised too", details.featuredGuests[0]?.linkedinUrl === "https://www.linkedin.com/in/kjohnson", String(details.featuredGuests[0]?.linkedinUrl));
    check("the guest count is a number, naming nobody", details.guestCount === 214, String(details.guestCount));
    check("the calendar is the organiser", details.organizerName === "AI Tinkerers", String(details.organizerName));

    // The rows these become. The LinkedIn URL is the point: a name-only row keys at the
    // weakest tier and can never be recognised as the same person at a second event.
    const rows = peopleToAttendees(details.hosts, "host", details.platform);
    check("hosts become host rows", rows.every((r) => r.attendeeRole === "host"));
    check(
      "and key on LinkedIn where there is one",
      rows[0]?.identityKey === "li:https://www.linkedin.com/in/ada-lovelace",
      String(rows[0]?.identityKey)
    );
    // A Luma user id and a Partiful user id are only unique within their own platform.
    check("the platform id is namespaced", rows[0]?.externalRef === "luma:usr-host1", String(rows[0]?.externalRef));

    // Markup drift: platform JSON present, no event in it. The one failure this parser
    // cannot notice on its own, so it is recorded rather than silently returning nothing.
    const drifted = parseEventPage(
      `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">{"props":{}}</script></body></html>`,
      "https://lu.ma/moved"
    );
    check("drift is flagged", drifted.warnings.includes("platform-zero-yield"), drifted.warnings.join(","));

    // Truncation is indistinguishable from drift at the JSON level, and must not be treated
    // as an event: half a document is how a parser starts inventing things.
    const truncated = parseEventPage(
      `<html><body><script id="__NEXT_DATA__">{"props":{"pageProps":{"event":{"api_id":"evt-x"`,
      "https://lu.ma/cut-off"
    );
    check("a truncated payload yields nothing", truncated.providerEventId === null);
  }

  console.log("\nPartiful and Meetup");
  {
    const partiful = {
      props: {
        pageProps: {
          event: {
            title: "Rooftop Dinner",
            hosts: [{ id: "u1", displayName: "Alan Turing" }],
            goingGuestCount: 42,
            guestStatusCounts: { GOING: 42, MAYBE: 7 },
          },
        },
      },
    };
    const details = parseEventPage(
      `<html><body><script id="__NEXT_DATA__">${JSON.stringify(partiful)}</script></body></html>`,
      "https://partiful.com/e/kX9fT2vQ"
    );
    check("partiful is recognised", details.platform === "partiful");
    check("its id comes from the path", details.providerEventId === "kX9fT2vQ", String(details.providerEventId));
    check("the host is named", details.hosts[0]?.name === "Alan Turing", String(details.hosts[0]?.name));
    check("the going count is read", details.guestCount === 42, String(details.guestCount));
    // Partiful shows no guest list to anyone logged out, and we never log in.
    check("no guests are invented", details.featuredGuests.length === 0);
  }
  {
    const meetup = {
      props: {
        pageProps: {
          __APOLLO_STATE__: {
            "Event:1": {
              eventHosts: [{ member: { id: "m1", name: "Katherine Johnson" } }],
              goingCount: 88,
            },
            "Group:1": { __typename: "Group", name: "SF Python" },
          },
        },
      },
    };
    const details = parseEventPage(
      `<html><body><script id="__NEXT_DATA__">${JSON.stringify(meetup)}</script></body></html>`,
      "https://www.meetup.com/sf-python/events/301234567/"
    );
    check("meetup is recognised", details.platform === "meetup");
    check("its id comes from the path", details.providerEventId === "301234567", String(details.providerEventId));
    check("the organiser is named", details.hosts[0]?.name === "Katherine Johnson", String(details.hosts[0]?.name));
    check("the going count is read", details.guestCount === 88, String(details.guestCount));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll event parsing checks passed.");
}

main();
