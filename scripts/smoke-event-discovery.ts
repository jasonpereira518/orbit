/**
 * Recognising an event: link extraction, platform ids, dedup keys, and what is NOT an event.
 *
 * `pure` tier — every module under test is fetch-free and database-free.
 *
 * The checks that matter most are the refusals. Discovery reads text nobody wrote for us, and
 * its expensive failure mode is not "missed an event" but "made an event out of the Zoom link
 * in a team standup", which puts rows on someone's page that they then have to clean up one
 * by one. Every "not an event" assertion below is one of those.
 */
import {
  extractEventLinks,
  platformForEmailDomain,
  platformOf,
} from "../src/lib/events/platforms";
import {
  canonicalEventKey,
  candidateKeys,
  mergeCandidates,
} from "../src/lib/events/discovery/keys";
import {
  calendarEventsToCandidates,
  isEventPlatformInvite,
  isRoleEmail,
} from "../src/lib/events/discovery/from-calendar";
import { classifyCalendarEvent } from "../src/lib/calendar-classify";
import { parseIcsEvents } from "../src/lib/calendar-import";
import type { ParsedCalendarEvent } from "../src/lib/calendar-import";
import type { DiscoveryCandidate } from "../src/lib/events/discovery/types";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function calendarEvent(over: Partial<ParsedCalendarEvent> = {}): ParsedCalendarEvent {
  return {
    uid: "uid-1",
    summary: "An event",
    description: "",
    location: "",
    start: new Date("2026-06-01T18:00:00.000Z"),
    end: new Date("2026-06-01T21:00:00.000Z"),
    attendees: [],
    organizer: null,
    ...over,
  };
}

function candidate(over: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return {
    source: "gcal",
    sourceRef: "gcal:uid-1",
    url: null,
    platform: null,
    providerEventId: null,
    title: null,
    startsAt: null,
    endsAt: null,
    timezone: null,
    location: null,
    roleHint: null,
    rsvpHint: null,
    attendees: [],
    evidence: {},
    ...over,
  };
}

function main() {
  console.log("\nrecognising a platform from a URL");
  {
    check("a Luma share link", platformOf("https://lu.ma/abc123")?.platform === "luma");
    check(
      "a Luma event id is extracted where the URL has one",
      platformOf("https://lu.ma/e/evt-AbC123")?.providerEventId === "evt-AbC123",
      String(platformOf("https://lu.ma/e/evt-AbC123")?.providerEventId)
    );
    check(
      "a slug is not mistaken for an id",
      platformOf("https://luma.com/abc123")?.providerEventId === null
    );
    check("partiful", platformOf("https://partiful.com/e/xYz789")?.providerEventId === "xYz789");
    check(
      "eventbrite reads the id out of the slug",
      platformOf("https://www.eventbrite.com/e/founder-mixer-tickets-123456789")
        ?.providerEventId === "123456789"
    );
    check(
      "eventbrite on a ccTLD is still eventbrite",
      platformOf("https://www.eventbrite.co.uk/e/x-tickets-987654321")?.platform === "eventbrite"
    );
    check(
      "meetup",
      platformOf("https://www.meetup.com/sf-python/events/301234567/")?.providerEventId ===
        "301234567"
    );

    // Refusals: a platform's own marketing and account pages are not events.
    check("luma's discover page is not an event", platformOf("https://lu.ma/discover") === null);
    check("a luma user profile is not an event", platformOf("https://lu.ma/user/usr-1") === null);
    check("a meetup group page is not an event", platformOf("https://www.meetup.com/sf-python/") === null);
    check("an unrelated host is not a platform", platformOf("https://example.com/e/party") === null);
    check("a lookalike domain is refused", platformOf("https://notlu.ma/abc") === null);
    check("junk is refused", platformOf("not a url") === null);
  }

  console.log("\npulling event links out of prose");
  {
    const description = `Hi all,
      Join here: https://lu.ma/ai-tinkerers?tk=SECRETGUESTTOKEN
      Zoom backup: https://zoom.us/j/123456
      Directions: https://maps.google.com/?q=Shack15
      Unsubscribe: https://example.com/unsub`;
    const links = extractEventLinks(description);
    check("the event link is found", links.length === 1, links.join(" "));
    // The token identifies the RECIPIENT. It must never reach the database, let alone be
    // rendered back as a clickable link on the event page.
    check("the personal guest token is stripped", !links[0]?.includes("SECRETGUESTTOKEN"), links[0]);
    check("the Zoom link is not an event", !links.join(" ").includes("zoom.us"));
    check("nor the map, nor the unsubscribe footer", !links.join(" ").includes("maps.google"));
  }
  {
    const links = extractEventLinks("See (https://partiful.com/e/abc123), it'll be fun.");
    check("trailing punctuation is trimmed", links[0] === "https://partiful.com/e/abc123", links[0]);
  }
  {
    const links = extractEventLinks(
      "https://lu.ma/one-party https://lu.ma/one-party https://partiful.com/e/kX9fT2vQ"
    );
    check("duplicates collapse", links.length === 2, links.join(" "));
  }
  {
    // An order page is real, and yet no public event page can be derived from it.
    check(
      "an Eventbrite order link is refused",
      extractEventLinks("https://www.eventbrite.com/orders/123456").length === 0
    );
  }

  console.log("\nsender domains");
  {
    check("luma's mailer", platformForEmailDomain("invites@lu.ma") === "luma");
    check("a subdomain", platformForEmailDomain("no-reply@order.eventbrite.com") === "eventbrite");
    // The whole point of reading a confirmation email is that we then fetch a link out of it,
    // so "contains lu.ma" would be a gift to anyone registering lu-ma-invites.example.
    check("a lookalike sender is refused", platformForEmailDomain("hi@lu.ma.phish.example") === null);
    check("an ordinary sender", platformForEmailDomain("jane@example.com") === null);
    check("role inboxes are recognisable", isRoleEmail("no-reply@lu.ma") && isRoleEmail("events@x.io"));
    check("a person is not a role inbox", !isRoleEmail("jane.doe@example.com"));
  }

  console.log("\ndedup keys");
  {
    // Four spellings of one party. Keyed by URL as typed, this is four events.
    const keys = [
      "https://lu.ma/abc",
      "https://luma.com/abc",
      "https://lu.ma/abc?tk=TOKEN",
      "http://www.luma.com/abc/",
    ].map(canonicalEventKey);
    check("every spelling folds onto one key", new Set(keys).size === 1, keys.join(" | "));
  }
  {
    const keys = candidateKeys(
      candidate({ url: "https://lu.ma/e/evt-6mLuOvNx", sourceRef: "gcal:uid-9" })
    );
    check("the provider id is the strongest key", keys[0]?.value === "luma:evt-6mLuOvNx", keys[0]?.value);
    check("the url is a key too", keys.some((k) => k.kind === "url"));
    check("and so is the source's own ref", keys.some((k) => k.value === "gcal:uid-9"));
  }

  console.log("\nmerging two reports of one event");
  {
    const merged = mergeCandidates([
      candidate({
        source: "gcal",
        sourceRef: "gcal:uid-1",
        url: "https://lu.ma/abc",
        title: "AI Tinkerers",
        attendees: [
          {
            externalRef: null,
            fullName: "Ada",
            email: "ada@x.io",
            company: null,
            title: null,
            linkedinUrl: null,
            xHandle: null,
            phone: null,
            attendeeRole: "attendee",
          },
        ],
      }),
      candidate({
        source: "luma_ics",
        sourceRef: "ics:evt-6mLuOvNx",
        url: "https://luma.com/abc",
        timezone: "America/Los_Angeles",
        roleHint: "hosted",
      }),
    ]);
    check("two reports become one candidate", merged.length === 1, String(merged.length));
    check("the first source keeps the badge", merged[0]?.source === "gcal", merged[0]?.source);
    check("but the other's facts are kept", merged[0]?.timezone === "America/Los_Angeles");
    check("hosted wins over an assumed role", merged[0]?.roleHint === "hosted");
    check("the guest list survives", merged[0]?.attendees.length === 1);
    // Otherwise the losing feed rediscovers its event on every single pass.
    check(
      "both source refs are kept as keys",
      candidateKeys(merged[0]!).some((k) => k.value === "ics:evt-6mLuOvNx")
    );
  }
  {
    const merged = mergeCandidates([
      candidate({ sourceRef: "a", url: "https://lu.ma/one" }),
      candidate({ sourceRef: "b", url: "https://partiful.com/e/two" }),
    ]);
    check("two genuinely different events stay separate", merged.length === 2);
  }

  console.log("\nwhich calendar entries are events");
  {
    check(
      "a Luma link in the location",
      isEventPlatformInvite(calendarEvent({ location: "https://lu.ma/abc" }))
    );
    check(
      "a platform organiser with no link at all",
      isEventPlatformInvite(
        calendarEvent({ organizer: { name: "Luma", email: "invites@lu.ma" } })
      )
    );
    check(
      "an ordinary 1:1 is not an event",
      !isEventPlatformInvite(
        calendarEvent({
          summary: "Coffee with Ada",
          organizer: { name: "Ada", email: "ada@x.io" },
        })
      )
    );
    check(
      "a Zoom meeting is not an event",
      !isEventPlatformInvite(calendarEvent({ description: "https://zoom.us/j/1234" }))
    );
  }

  console.log("\nthe classifier stops fabricating meetings from invites");
  {
    // The bug: `counterpartsOf` treats the organiser as a counterpart, so a 200-person Luma
    // party looked like a 1:1 with "invites@lu.ma" — which created a contact called "invites",
    // logged a meeting nobody attended, and scheduled a follow-up nudge to a mailbox.
    const invite = calendarEvent({
      summary: "AI Tinkerers SF",
      description: "RSVP: https://lu.ma/ai-tinkerers",
      organizer: { name: "Luma", email: "invites@lu.ma" },
      attendees: [{ name: "You", email: "me@example.com" }],
    });
    const verdict = classifyCalendarEvent(invite, ["me@example.com"]);
    check("a platform invite is not a meeting", verdict.keep === false, verdict.reason);
    check("and says why", /event-platform invite/i.test(verdict.reason), verdict.reason);

    // The neighbouring case must still work, or this fix costs the user their real meetings.
    const coffee = calendarEvent({
      summary: "Coffee with Ada",
      organizer: { name: "Ada", email: "ada@x.io" },
      attendees: [
        { name: "Ada", email: "ada@x.io" },
        { name: "You", email: "me@example.com" },
      ],
    });
    check("a real 1:1 still counts", classifyCalendarEvent(coffee, ["me@example.com"]).keep);
  }

  console.log("\ncalendar entries as candidates");
  {
    const candidates = calendarEventsToCandidates(
      [
        calendarEvent({
          uid: "uid-luma",
          summary: "AI Tinkerers SF",
          description: "RSVP: https://lu.ma/ai-tinkerers",
          attendees: [
            { name: "Ada Lovelace", email: "ada@x.io" },
            { name: "Luma", email: "invites@lu.ma" },
            { name: "You", email: "me@example.com" },
          ],
        }),
        calendarEvent({ uid: "uid-standup", summary: "Team standup" }),
      ],
      ["me@example.com"],
      "gcal"
    );
    check("only the invite becomes a candidate", candidates.length === 1, String(candidates.length));
    check("the link is carried", candidates[0]?.url === "https://lu.ma/ai-tinkerers", String(candidates[0]?.url));
    check("the calendar UID is the source ref", candidates[0]?.sourceRef === "gcal:uid-luma");
    const guests = candidates[0]?.attendees ?? [];
    check("other guests come through", guests.length === 1, String(guests.length));
    check("the user is not their own guest", !guests.some((g) => g.email === "me@example.com"));
    check("and the platform mailer is not a guest", !guests.some((g) => g.email === "invites@lu.ma"));
    // The organiser's choice, honoured — Google returns the list to the owner regardless.
    const hiddenGuests = calendarEventsToCandidates(
      [
        calendarEvent({
          uid: "uid-hidden",
          location: "https://lu.ma/private",
          guestsVisible: false,
          attendees: [{ name: "Ada", email: "ada@x.io" }],
        }),
      ],
      [],
      "gcal"
    );
    check("a hidden guest list is not stored", hiddenGuests[0]?.attendees.length === 0);
  }

  console.log("\nICS feeds");
  {
    const feed = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:evt-6mLuOvNx@lu.ma
SUMMARY:AI Tinkerers SF
DTSTART;TZID=America/New_York:20260704T190000
DTEND;TZID=America/New_York:20260704T220000
URL:https://lu.ma/e/evt-6mLuOvNx
STATUS:TENTATIVE
LOCATION:Shack15
END:VEVENT
END:VCALENDAR`;
    const parsed = parseIcsEvents(feed);
    check("the event's own URL is read", parsed[0]?.url === "https://lu.ma/e/evt-6mLuOvNx", String(parsed[0]?.url));
    check("the status is read", parsed[0]?.status === "TENTATIVE");
    check("the TZID is kept", parsed[0]?.timezone === "America/New_York", String(parsed[0]?.timezone));
    // Without the TZID this wall clock is read in the SERVER's zone — the same class of bug
    // `wall-clock.ts` exists to prevent, and one that moves the event by hours.
    check(
      "a floating time is read in the venue's zone, not the server's",
      parsed[0]?.start?.toISOString() === "2026-07-04T23:00:00.000Z",
      String(parsed[0]?.start?.toISOString())
    );

    const candidates = calendarEventsToCandidates(parsed, [], "luma_ics");
    check("it becomes a candidate", candidates.length === 1);
    check("with the provider id from its URL", candidates[0]?.providerEventId === "evt-6mLuOvNx");
    check("and a tentative RSVP", candidates[0]?.rsvpHint === "maybe", String(candidates[0]?.rsvpHint));
  }

  console.log(
    failures === 0 ? "\nAll event discovery checks passed\n" : `\n${failures} check(s) failed\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
