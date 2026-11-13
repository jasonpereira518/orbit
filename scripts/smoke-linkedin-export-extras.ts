/**
 * The extras read from a kept LinkedIn export: per-person notes, target companies, wanted job
 * titles and background. Real header rows, made-up values.
 *
 * Pure. Run: npx tsx scripts/smoke-linkedin-export-extras.ts
 */
import {
  parseExportBackground,
  parseExportJobTitles,
  parseExportSignals,
  parseExportStamp,
  parseExportTargets,
} from "../src/lib/linkedin-export-extras";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const INVITATIONS = [
  "From,To,Sent At,Message,Direction,inviterProfileUrl,inviteeProfileUrl",
  'Me Myself,Ada Lovelace,"9/22/26, 8:50 AM","Hi Ada! Loved your talk,\nwould love to connect",OUTGOING,https://www.linkedin.com/in/me,https://www.linkedin.com/in/ada-l',
  'Grace Hopper,Me Myself,"9/21/26, 9:43 PM","Hey — met you at the fair",INCOMING,https://www.linkedin.com/in/grace,https://www.linkedin.com/in/me',
  'Me Myself,Alan Turing,"9/20/26, 12:37 PM",,OUTGOING,https://www.linkedin.com/in/me,https://www.linkedin.com/in/alan',
].join("\n");
const NOTES = [
  "Connection First Name,Connection Last Name,Connection Profile URL,Note,Created On,Edited On",
  "Ada,Lovelace,https://www.linkedin.com/in/ada-l,Ask about the engine,2026-09-10,",
].join("\n");
const RECS = [
  "First Name,Last Name,Company,Job Title,Text,Creation Date,Status",
  'Grace,Hopper,Navy,Admiral,"A brilliant engineer.","08/25/26, 07:03 PM",VISIBLE',
  'Hidden,Person,Acme,CEO,"Nope","08/12/26, 03:38 AM",HIDDEN',
].join("\n");
const PREFS = [
  "Locations,Industries,Company Employee Count,Preferred Job Types,Job Titles,Open To Recruiters,Dream Companies",
  'Raleigh,Software,,Full-time,"Software Engineer | Data Analyst | software engineer",Yes,"Anthropic | Stripe"',
].join("\n");
const APPS = [
  "Application Date,Contact Email,Contact Phone Number,Company Name,Job Title,Job Url,Resume Name,Question And Answers",
  '"11/13/25, 11:35 AM",me@x.com,,Stripe,SWE Intern,u,r,',
  '"12/11/25, 8:57 AM",me@x.com,,Citadel,SWE Intern,u,r,',
].join("\n");
const SAVED = ["Saved Date,Job Url,Job Title,Company Name", '"9/13/26, 7:57 PM",u,Engineer,Apple'].join("\n");
const CERTS = ["Name,Url,Authority,Started On,Finished On,License Number", "AWS Cloud Practitioner,u,Amazon Web Services,Mar 2024,,123"].join("\n");
const HONORS = ["Title,Description,Issued On", "Dean's List,d,Apr 2024"].join("\n");

async function main() {
  console.log("Dates");
  check("an invitation stamp", parseExportStamp("9/22/26, 8:50 AM")?.toISOString() === "2026-09-22T08:50:00.000Z");
  check("a recommendation stamp, zero-padded PM", parseExportStamp("08/25/26, 07:03 PM")?.toISOString() === "2026-08-25T19:03:00.000Z");
  check("12 AM is midnight", parseExportStamp("1/1/26, 12:05 AM")?.toISOString() === "2026-01-01T00:05:00.000Z");
  check("a bare day lands at noon UTC, the same day everywhere", parseExportStamp("2026-09-20")?.toISOString() === "2026-09-20T12:00:00.000Z");
  check("an empty or unreadable stamp is null", parseExportStamp("") === null && parseExportStamp("soon") === null);

  console.log("Per-person notes");
  const texts = new Map([
    ["invitations.csv", INVITATIONS],
    ["notes.csv", NOTES],
    ["recommendations_received.csv", RECS],
  ]);
  const signals = parseExportSignals(texts);
  const sent = signals.find((s) => s.signal === "invitation_sent");
  const received = signals.find((s) => s.signal === "invitation_received");
  check("only invitations with a message become notes", signals.filter((s) => s.signal.startsWith("invitation")).length === 2);
  check(
    "a sent request is about the invitee, keeps its line break",
    sent?.linkedinUrl === "https://www.linkedin.com/in/ada-l" && sent.fullName === "Ada Lovelace" && sent.text.includes("\n"),
    JSON.stringify(sent),
  );
  check("a received request is about the inviter", received?.linkedinUrl === "https://www.linkedin.com/in/grace" && received.fullName === "Grace Hopper");
  check("the user's own LinkedIn note, by URL", signals.some((s) => s.signal === "note" && s.linkedinUrl?.endsWith("/ada-l") && s.text === "Ask about the engine"));
  const rec = signals.find((s) => s.signal === "recommendation_received");
  check("a recommendation carries name + company to match on, no URL", rec?.fullName === "Grace Hopper" && rec.company === "Navy" && rec.linkedinUrl === null);
  check("a hidden recommendation is left out", !signals.some((s) => s.fullName === "Hidden Person"));
  check("keys are stable across a re-read", JSON.stringify(parseExportSignals(texts).map((s) => s.externalKey)) === JSON.stringify(signals.map((s) => s.externalKey)));
  check("…and distinct per row", new Set(signals.map((s) => s.externalKey)).size === signals.length);

  console.log("Targets and titles");
  const jobTexts = new Map([
    ["jobs/job seeker preferences.csv", PREFS],
    ["jobs/job applications.csv", APPS],
    ["jobs/saved jobs.csv", SAVED],
    ["company follows.csv", "Organization,Followed On\nMeta,Mon Jan 05 2026\n"],
  ]);
  const targets = parseExportTargets(jobTexts);
  check(
    "dream companies first, applied and saved after, one per company, keenest reason kept",
    targets.map((t) => `${t.name}:${t.priority}`).join(",") === "Anthropic:1,Stripe:1,Citadel:2,Apple:2",
    targets.map((t) => `${t.name}:${t.priority}`).join(","),
  );
  check("an application says when", targets.find((t) => t.name === "Citadel")?.note === "From LinkedIn: applied 2025-12-11");
  check("company follows are never targets", !targets.some((t) => t.name === "Meta"));
  check("wanted titles, de-duplicated ignoring case", parseExportJobTitles(jobTexts).join("|") === "Software Engineer|Data Analyst");
  check("no preferences file, no titles and no targets", parseExportJobTitles(new Map()).length === 0 && parseExportTargets(new Map()).length === 0);

  console.log("Background");
  const bg = parseExportBackground(new Map([["certifications.csv", CERTS], ["honors.csv", HONORS]]));
  check(
    "certifications and honors, empty fields dropped",
    JSON.stringify(bg) ===
      JSON.stringify([
        { kind: "certification", title: "AWS Cloud Practitioner", org: "Amazon Web Services", start: "Mar 2024" },
        { kind: "honor", title: "Dean's List", start: "Apr 2024" },
      ]),
    JSON.stringify(bg),
  );
  check("the license number is never read", !JSON.stringify(bg).includes("123"));

  if (failures) {
    console.error(`\n${failures} extras check${failures === 1 ? "" : "s"} failed`);
    process.exit(1);
  }
  console.log("\nlinkedin export extras smoke tests passed");
}

void main();
