/**
 * What a resync would change, and — more importantly — what it would not.
 *
 * Resync REPLACES, which makes it the only destructive read in the events feature. Two
 * properties keep that safe, and both are asserted here:
 *
 *   1. A field the page did not mention is never cleared. A host reshuffling their markup, or
 *      one missed tag, would otherwise blank the venue on every event that page produced.
 *      This is the assertion most likely to be broken by a "simplification" of `resolveField`.
 *   2. The diff is the complete list of what confirming will touch. A change the user was not
 *      shown must not happen, and a change they were shown must not be a no-op.
 *
 * Formatting matters too: both sides of a time diff are rendered in the same zone, or a page
 * that republished the identical instant with an explicit offset would invent a difference
 * and invite the user to "fix" nothing.
 */
import { diffEventAgainstPage, resolveField } from "../src/lib/events/resync";
import type { EventFieldChange } from "../src/lib/events/resync";
import type { EventPageDetails } from "../src/lib/events/parse-page";
import type { EventRecord } from "../src/db/schema";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function event(over: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "evt", userId: "u", title: "Founder Mixer",
    startsAt: new Date("2026-03-05T02:00:00.000Z"), endsAt: null, timezone: "-08:00",
    venue: "Shack15", city: "San Francisco", url: "https://lu.ma/x",
    role: "attended", source: "page", provider: null, providerEventId: null,
    description: "A night of demos.", organizerName: "AI Tinkerers",
    organizerUrl: "https://lu.ma/org", attendanceMode: "offline",
    coverImageUrl: "https://blob/cover.png", coverSourceUrl: "https://images.lu.ma/cover.png",
    themeColor: "#7C3AED", themeSource: "meta", themeLocked: 0,
    attendeeCount: null, notes: null, enrichedAt: null, enrichError: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  } as EventRecord;
}

function page(over: Partial<EventPageDetails> = {}): EventPageDetails {
  return {
    sourceUrl: "https://lu.ma/x", canonicalUrl: "https://lu.ma/x",
    title: "Founder Mixer", description: "A night of demos.",
    startsAt: new Date("2026-03-05T02:00:00.000Z"), endsAt: null, timezone: "-08:00",
    venue: "Shack15", city: "San Francisco",
    organizerName: "AI Tinkerers", organizerUrl: "https://lu.ma/org",
    attendanceMode: "offline", speakers: [],
    platform: null, providerEventId: null, hosts: [], featuredGuests: [], guestCount: null,
    imageUrl: "https://images.lu.ma/cover.png", themeColor: "#7C3AED", warnings: [],
    ...over,
  };
}

const fields = (changes: EventFieldChange[]) => changes.map((c) => c.field).sort().join(",");

function main() {
  console.log("\nan unchanged page proposes nothing");
  {
    const changes = diffEventAgainstPage(event(), page());
    check("no changes at all", changes.length === 0, fields(changes));
  }

  console.log("\nabsence is not a statement");
  {
    // The page came back with almost nothing — a markup change, or a partial parse. Not one
    // of these may be offered as a change, because confirming would wipe real data.
    const changes = diffEventAgainstPage(
      event(),
      page({
        title: null, venue: null, city: null, description: null,
        organizerName: null, organizerUrl: null, attendanceMode: null,
        startsAt: null, endsAt: null, imageUrl: null, themeColor: null,
      })
    );
    check("a stripped page proposes nothing", changes.length === 0, fields(changes));
  }
  check("resolveField keeps the stored value when the page is silent", resolveField(null, "Shack15") === "Shack15");
  check("resolveField takes the page's value when it has one", resolveField("New Hall", "Shack15") === "New Hall");
  check("resolveField reports null when neither has one", resolveField(null, null) === null);

  console.log("\nreal changes are listed with both sides");
  {
    const changes = diffEventAgainstPage(event(), page({ venue: "Kennedy Center", city: "Washington" }));
    check("only the fields that moved", fields(changes) === "city,venue", fields(changes));
    const venue = changes.find((c) => c.field === "venue")!;
    check("labelled for a human", venue.label === "Venue", venue.label);
    check("shows what it was", venue.from === "Shack15", String(venue.from));
    check("and what it would become", venue.to === "Kennedy Center", venue.to);
  }
  {
    const changes = diffEventAgainstPage(event({ venue: null }), page({ venue: "Kennedy Center" }));
    check("filling a blank is still a change", fields(changes) === "venue", fields(changes));
    check("with no 'from' to show", changes[0]?.from === null, String(changes[0]?.from));
  }

  console.log("\ntimes are compared in one zone");
  {
    // Same instant, and the event already holds the same offset: no difference to report.
    const changes = diffEventAgainstPage(event(), page({ startsAt: new Date("2026-03-05T02:00:00.000Z") }));
    check("an identical instant is not a change", changes.length === 0, fields(changes));
  }
  {
    const changes = diffEventAgainstPage(event(), page({ startsAt: new Date("2026-03-05T03:00:00.000Z") }));
    const start = changes.find((c) => c.field === "startsAt")!;
    check("a moved start is reported", !!start);
    // -08:00, so 02:00Z is 18:00 the previous day and 03:00Z is 19:00.
    check("in the venue's wall clock, not UTC", start.from === "2026-03-04 18:00", String(start.from));
    check("both sides of it", start.to === "2026-03-04 19:00", start.to);
  }

  console.log("\nwhat resync will not touch");
  {
    const changes = diffEventAgainstPage(event({ themeLocked: 1 }), page({ themeColor: "#ff0000" }));
    check("a locked accent colour is never offered", !changes.some((c) => c.field === "themeColor"), fields(changes));
  }
  {
    const changes = diffEventAgainstPage(event(), page({ themeColor: "#ff0000" }));
    check("an unlocked one is", changes.some((c) => c.field === "themeColor"), fields(changes));
  }
  {
    const changes = diffEventAgainstPage(event(), page({ imageUrl: "https://images.lu.ma/new.png" }));
    check("new cover art is noticed", changes.some((c) => c.field === "coverImageUrl"), fields(changes));
  }
  {
    // Same source URL as last time: the graphic has not changed, whatever the Blob URL is.
    const changes = diffEventAgainstPage(event(), page());
    check("the same cover art is not", !changes.some((c) => c.field === "coverImageUrl"), fields(changes));
  }
  {
    const changes = diffEventAgainstPage(
      event(),
      page({ speakers: [{ name: "Ada", url: null }, { name: "Grace", url: null }] })
    );
    const speakers = changes.find((c) => c.field === "speakers")!;
    check("speakers are described as additive", speakers.to.includes("added to the roster if missing"), speakers.to);
    check("and never as a replacement", speakers.from === null, String(speakers.from));
  }

  console.log(failures === 0 ? "\nAll resync checks passed\n" : `\n${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
