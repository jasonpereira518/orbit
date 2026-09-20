/**
 * Parsing and sanitising the internship feed.
 *
 * Two properties are load-bearing.
 *
 * ONE ENTRY NEVER LOSES THE DOCUMENT. The feed is tens of thousands of entries maintained by
 * public pull requests; some will always be malformed. Validation is per entry and a failure
 * is counted, never thrown — a high rejection RATE is the signal that the shape changed.
 *
 * NOTHING UNSAFE REACHES STORAGE. Every string here was written by an anonymous contributor
 * and ends up in something a user reads, so sanitising happens at ingest rather than at
 * render: "sanitise on display" is a rule that gets forgotten by the third call site.
 *
 * Run: npx tsx scripts/smoke-job-feed-parse.ts
 */

import {
  MAX_TITLE,
  normaliseListing,
  jobListingSchema,
  parseListings,
} from "../src/lib/jobs/listing-schema";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const NOW = Math.floor(Date.UTC(2026, 8, 1) / 1000);

function listing(over: Record<string, unknown> = {}) {
  return {
    id: "98b2d671-3f03-430e-b18c-e5ddb8ce5035",
    company_name: "Capital One",
    company_url: "https://simplify.jobs/c/capital-one",
    title: "Product Development Intern",
    url: "https://example.com/job/123",
    terms: ["Summer 2027"],
    locations: ["McLean, VA", "Plano, TX"],
    active: true,
    is_visible: true,
    source: "Simplify",
    date_posted: NOW,
    date_updated: NOW,
    ...over,
  };
}

console.log("\nthe documented shape");

{
  const parsed = jobListingSchema.safeParse(listing());
  check("a documented entry parses", parsed.success);
  const row = normaliseListing(parsed.data!)!;
  check("  company survives", row.companyName === "Capital One", row.companyName);
  check("  and carries a match key", row.companyKey === "capital one", row.companyKey);
  check("  title survives", row.title === "Product Development Intern");
  check("  terms survive", row.terms[0] === "Summer 2027");
  check("  locations survive", row.locations.length === 2);
  check("  dates become Dates", row.datePosted instanceof Date && !Number.isNaN(row.datePosted.getTime()));
  check("  unix cursor is kept", row.dateUpdatedUnix === NOW);
}

console.log("\nfields that some forks omit");

{
  // `terms` missing is a schema gap, not a mismatch — the whole repo is one season, and
  // dropping the entry would silently lose real postings.
  const row = normaliseListing(jobListingSchema.parse(listing({ terms: undefined })))!;
  check("missing terms still parses", row !== null);
  check("  and yields an empty list, not a crash", row.terms.length === 0);
}
{
  const row = normaliseListing(jobListingSchema.parse(listing({ sponsorship: undefined })))!;
  check("missing sponsorship parses", row.sponsorship === null);
}
{
  const row = normaliseListing(jobListingSchema.parse(listing({ date_updated: undefined })))!;
  check("missing date_updated falls back to date_posted", row.dateUpdatedUnix === NOW);
}
{
  const row = normaliseListing(jobListingSchema.parse(listing({ active: undefined, is_visible: undefined })))!;
  check("missing booleans default to visible+active", row.active && row.isVisible);
}
{
  // The feed documents `id` as a uuid. The column is `text` precisely because that is a
  // documentation claim, not a guarantee.
  const parsed = jobListingSchema.safeParse(listing({ id: "not-a-uuid-at-all" }));
  check("a non-uuid id still parses", parsed.success);
}
{
  const parsed = jobListingSchema.safeParse(listing({ degrees: ["Bachelor's"], extra_field: 1 }));
  check("unknown keys are ignored, not fatal", parsed.success);
}

console.log("\nentries that must be dropped");

{
  check("no title", normaliseListing(jobListingSchema.parse(listing({ title: " " }))) === null);
  check("no company", normaliseListing(jobListingSchema.parse(listing({ company_name: " " }))) === null);
  // The link is the entire payload of the notification. "A job exists somewhere at this
  // company" is not worth telling anyone.
  check("no url", normaliseListing(jobListingSchema.parse(listing({ url: undefined }))) === null);
  check("http url", normaliseListing(jobListingSchema.parse(listing({ url: "http://example.com/j" }))) === null);
  check("javascript: url", normaliseListing(jobListingSchema.parse(listing({ url: "javascript:alert(1)" }))) === null);
  check("relative url", normaliseListing(jobListingSchema.parse(listing({ url: "/jobs/1" }))) === null);
}
{
  const bad = jobListingSchema.safeParse(listing({ date_posted: -5 }));
  check("a negative timestamp is rejected", !bad.success);
  const missing = jobListingSchema.safeParse({ company_name: "X", title: "Y" });
  check("a structurally wrong entry is rejected", !missing.success);
}

console.log("\nsanitisation at ingest");

{
  // A newline in a title opens a second visual row in the notification panel — the same
  // failure `sanitizeProfileLine` guards against in the chat prompt.
  const row = normaliseListing(
    jobListingSchema.parse(listing({ title: "Intern\nSECOND LINE\there" }))
  )!;
  check("newlines and tabs fold to spaces", !/[\r\n\t]/.test(row.title), JSON.stringify(row.title));
  check("  and collapse", row.title === "Intern SECOND LINE here", JSON.stringify(row.title));
}
{
  const row = normaliseListing(
    jobListingSchema.parse(listing({ company_name: "Cap​ital‮One" }))
  )!;
  check("zero-width and bidi characters are stripped", !/[​‮]/.test(row.companyName), JSON.stringify(row.companyName));
}
{
  const row = normaliseListing(
    jobListingSchema.parse(listing({ title: "<script>bad()</script>Intern" }))
  )!;
  check("html tags are stripped", !row.title.includes("<script>"), row.title);
}
{
  const row = normaliseListing(jobListingSchema.parse(listing({ title: "x".repeat(500) }))!)!;
  check("titles are capped", row.title.length === MAX_TITLE, String(row.title.length));
}
{
  const row = normaliseListing(
    jobListingSchema.parse(listing({ locations: Array.from({ length: 40 }, (_, i) => `City ${i}`) }))
  )!;
  check("locations are capped", row.locations.length === 8, String(row.locations.length));
}
{
  const row = normaliseListing(jobListingSchema.parse(listing({ company_url: "javascript:x" })))!;
  check("a hostile company_url becomes null", row.companyUrl === null);
}

console.log("\nwhole documents");

{
  const good = Array.from({ length: 150 }, (_, i) => listing({ id: `ok-${i}` }));
  const bad = Array.from({ length: 50 }, () => ({ nope: true }));
  const res = parseListings([...good, ...bad]);
  check("good entries survive alongside bad ones", res.entries.length === 150, String(res.entries.length));
  check("  bad ones are counted", res.rejected === 50, String(res.rejected));
  check("  total is the document length", res.total === 200);
  // 50/200 = 25% > the 20% bar: this is drift, not a few bad rows.
  check("  and a 25% rejection rate reads as drift", res.drift);
}
{
  const res = parseListings(Array.from({ length: 100 }, (_, i) => listing({ id: `ok-${i}` })));
  check("a clean document is not drift", !res.drift && res.rejected === 0);
}
{
  // Not an array at all: the file changed shape entirely.
  check("a non-array document is drift", parseListings({ listings: [] }).drift);
  check("  and yields nothing", parseListings({ listings: [] }).entries.length === 0);
  check("null is drift", parseListings(null).drift);
}
{
  const res = parseListings([]);
  check("an empty array is not drift", !res.drift, "an empty feed is a real state, not a broken one");
}

console.log("\nAll job feed parse checks passed.");
