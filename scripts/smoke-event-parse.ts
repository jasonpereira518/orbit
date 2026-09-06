/**
 * Event page parsing and roster parsing.
 *
 * The fixtures are shaped like the real thing (Luma renders JSON-LD, Eventbrite leans on
 * OpenGraph, Partiful gives little more than a title) so that when one of them reshuffles
 * their markup, a failing assertion says so rather than events quietly arriving blank.
 *
 * The load-bearing negative: `parseEventPage` returns no attendee field at all. Guest lists
 * are never scraped, and a test that asserts the shape is what keeps a future edit from
 * "helpfully" adding one.
 */
import { parseEventPage } from "../src/lib/events/parse-page";
import { parseRosterCsv, parseRosterText, MAX_ROSTER_ROWS } from "../src/lib/events/parse-roster";

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
 "image":"https://images.lu.ma/logo-small.png"}
</script></head><body>...</body></html>`;

const EVENTBRITE = `<!doctype html><html><head>
<meta property="og:title" content="Founder Mixer">
<meta property="og:image" content="https://img.evbuc.com/hero.jpg">
<meta property="og:url" content="https://www.eventbrite.com/e/founder-mixer-123">
</head><body></body></html>`;

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
    check("NO attendee field is exposed", !("attendees" in d) && !("guests" in d));
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

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll event parsing checks passed.");
}

main();
