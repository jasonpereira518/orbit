/**
 * The LinkedIn files about YOU: Profile.csv, Positions.csv, Skills.csv, SavedJobAlerts.csv.
 *
 * Fixtures use the real header rows and the real Java-style `QUERY_CONTEXT` string (the format
 * that makes these worth a test: it is not JSON, locations are numeric geo ids, and the one
 * useful key is `keywords=`) with made-up values.
 *
 * Pure tier. Run: npx tsx scripts/smoke-linkedin-you.ts
 */
import {
  parseLinkedInAlertsCsv,
  parseLinkedInPositionsCsv,
  parseLinkedInProfileCsv,
  parseLinkedInSkillsCsv,
} from "../src/lib/linkedin-you";
import { patchYou, previewYou } from "../src/lib/career-profile";
import { LinkedInExportError } from "../src/lib/linkedin-connections";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function throwsExport(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof LinkedInExportError;
  }
}

const PROFILE =
  "First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers\n" +
  'Ada,Tester,,12 Secret Street,"Jan 1, 1990",Backend engineer building payments,"Builds things.\nLoves queues.",Technology,12345,"Arlington, Virginia, United States",,[PERSONAL:https://example.com],\n';

const POSITIONS =
  "Company Name,Title,Description,Location,Started On,Finished On\n" +
  'Acme Cloud,Solutions Architect Intern,Summer 2026,"Arlington, VA",May 2026,\n' +
  "Old Co,Developer,,Remote,Jan 2023,Aug 2024\n";

const SKILLS = "Name\nSoftware Development\nProduct Management\nproduct management\nArtificial Intelligence (AI)\n";

const ALERT_QUERY = (kw: string | null, geo: string) =>
  `"{smartExpansionEnabled=true, channels=[INAPP_NOTIFICATION, EMAIL], frequency=DAILY}","{${
    kw ? `keywords=${kw}, ` : ""
  }spellCheckEnabled=true, searchLocation={com.linkedin.jobs.matching.SpecificSearchLocation={geoLocations=[{geo=urn:li:geo:${geo}, radiusInKms=40.2335}]}}, facets={workplaceTypes={selectedValues=[urn:li:workplaceType:1]}}}",${geo}`;
const ALERTS =
  "ALERT_PARAMETERS,QUERY_CONTEXT,SAVED_SEARCH_ID\n" +
  [ALERT_QUERY("Software Engineer", "1"), ALERT_QUERY("software engineer", "2"), ALERT_QUERY("Platform Engineer", "3"), ALERT_QUERY(null, "4")].join("\n") +
  "\n";

console.log("Profile.csv");
const profile = parseLinkedInProfileCsv(PROFILE);
check("headline, industry, location", profile.headline === "Backend engineer building payments" && profile.industry === "Technology" && profile.location?.startsWith("Arlington") === true, JSON.stringify(profile));
check("summary is folded onto one line", profile.summary === "Builds things. Loves queues.", String(profile.summary));
check("address, birth date and zip are never read", !JSON.stringify(profile).match(/Secret|1990|12345/));
check("BOM tolerated", parseLinkedInProfileCsv("﻿" + PROFILE).headline === profile.headline);
check("a non-Profile file is refused with a readable error", throwsExport(() => parseLinkedInProfileCsv("First Name,Last Name,Email\nA,B,c@d.e\n")));

console.log("\nPositions.csv");
check("the open-ended row is the current role", JSON.stringify(parseLinkedInPositionsCsv(POSITIONS)) === JSON.stringify({ title: "Solutions Architect Intern", company: "Acme Cloud" }));
check("every role ended means no current role", parseLinkedInPositionsCsv("Company Name,Title,Description,Location,Started On,Finished On\nOld Co,Dev,,,Jan 2023,Aug 2024\n") === null);

console.log("\nSkills.csv");
const skills = parseLinkedInSkillsCsv(SKILLS);
check("de-duplicated case-insensitively, first spelling kept", skills.length === 3 && skills[1] === "Product Management", JSON.stringify(skills));
const many = "Name\n" + Array.from({ length: 150 }, (_, i) => `Skill ${i}`).join("\n") + "\n";
check("capped at 100", parseLinkedInSkillsCsv(many).length === 100);
check("an over-long term is cut", parseLinkedInSkillsCsv("Name\n" + "x".repeat(200) + "\n")[0].length === 60);
check("a markup injection is stripped", !/<script/i.test(parseLinkedInSkillsCsv("Name\n<script>alert(1)</script>Go\n")[0] ?? ""));

console.log("\nSavedJobAlerts.csv");
const keywords = parseLinkedInAlertsCsv(ALERTS);
check("reads keywords= only, de-duplicated, skipping an alert with none", JSON.stringify(keywords) === JSON.stringify(["Software Engineer", "Platform Engineer"]), JSON.stringify(keywords));
check("a file with no keywords gives an empty list, not an error", parseLinkedInAlertsCsv("ALERT_PARAMETERS,QUERY_CONTEXT,SAVED_SEARCH_ID\n" + ALERT_QUERY(null, "9") + "\n").length === 0);

console.log("\nthe review");
const none = { career: null, senderBio: null };
const typed = { career: { profile: { headline: "Old headline" }, skills: ["Go"] }, senderBio: "I am a founder looking for design partners" };
let fields = previewYou("linkedin_profile", PROFILE, none);
check("every offered field has a stable key", fields.map((f) => f.key).join() === "profile.headline,profile.industry,profile.location,profile.summary,about", fields.map((f) => f.key).join());
check("with no About line typed, the About field starts ticked", fields.find((f) => f.key === "about")?.defaultOn === true);
fields = previewYou("linkedin_profile", PROFILE, typed);
check("a typed About line is shown as the 'before' and starts UNticked", fields.find((f) => f.key === "about")?.before === typed.senderBio && fields.find((f) => f.key === "about")?.defaultOn === false);
check("a previous import's headline is shown as the before", fields.find((f) => f.key === "profile.headline")?.before === "Old headline");
check("a role file with no current role says so", throwsExport(() => previewYou("linkedin_positions", "Company Name,Title,Description,Location,Started On,Finished On\nOld Co,Dev,,,Jan 2023,Aug 2024\n", none)));
check("alerts with no titles are refused", throwsExport(() => previewYou("linkedin_alerts", "ALERT_PARAMETERS,QUERY_CONTEXT,SAVED_SEARCH_ID\n" + ALERT_QUERY(null, "9") + "\n", none)));

console.log("\nthe patch");
const now = new Date("2026-10-08T12:00:00Z");
let patch = patchYou("linkedin_profile", PROFILE, ["profile.industry", "profile.location"], typed, now);
check("only ticked profile fields change; the old headline is kept", patch?.career.profile?.headline === "Old headline" && patch?.career.profile?.industry === "Technology", JSON.stringify(patch?.career.profile));
check("without 'about' ticked, sender_bio is not written", patch?.senderBio === null);
patch = patchYou("linkedin_profile", PROFILE, ["about"], typed, now);
check("with 'about' ticked, it replaces sender_bio with the headline", patch?.senderBio === "Backend engineer building payments");
check("a patch carries its import time", patch?.career.importedAt === now.toISOString());
patch = patchYou("linkedin_skills", SKILLS, ["skills"], typed, now);
check("skills replace the skills key and touch nothing else", patch?.career.skills?.length === 3 && patch?.career.profile === undefined && patch?.career.role === undefined);
check("a key the file never offered is ignored; nothing ticked means no patch", patchYou("linkedin_skills", SKILLS, ["role", "profile.headline"], typed, now) === null && patchYou("linkedin_skills", SKILLS, [], typed, now) === null);
patch = patchYou("linkedin_positions", POSITIONS, ["role"], none, now);
check("role patch", patch?.career.role?.company === "Acme Cloud");
patch = patchYou("linkedin_alerts", ALERTS, ["roleKeywords"], none, now);
check("alert patch", patch?.career.roleKeywords?.join() === "Software Engineer,Platform Engineer");

console.log(failures ? `\n${failures} check(s) failed` : "\nsmoke-linkedin-you: all checks passed");
if (failures) process.exit(1);
process.exit(0);
