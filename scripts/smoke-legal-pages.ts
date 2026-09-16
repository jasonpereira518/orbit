/**
 * The legal pages must say what the code does. This reads their source and pins the
 * statements Google verification and the audit (A3) require, the corrections that must not
 * regress, and the link between the Google scope table and the scopes the code requests.
 * Pure. Run: npx tsx scripts/smoke-legal-pages.ts
 */
import { readFileSync } from "node:fs";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { GOOGLE_LIMITED_USE, GOOGLE_LIMITED_USE_SENTENCE, GOOGLE_SCOPE_DISCLOSURES } from "../src/lib/legal";

const privacy = readFileSync("src/app/(site)/(docs)/privacy/page.tsx", "utf8");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("Google Limited Use");
check(
  "the sentence is Google's required wording, verbatim",
  GOOGLE_LIMITED_USE_SENTENCE ===
    "Orbit's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements."
);
check("the rendered pieces join into that sentence", GOOGLE_LIMITED_USE.before + GOOGLE_LIMITED_USE.linkText + GOOGLE_LIMITED_USE.after === GOOGLE_LIMITED_USE_SENTENCE);
check("it links the User Data Policy", GOOGLE_LIMITED_USE.href === "https://developers.google.com/terms/api-services-user-data-policy");
check("the privacy page renders all four parts", ["GOOGLE_LIMITED_USE.before", "GOOGLE_LIMITED_USE.linkText", "GOOGLE_LIMITED_USE.after", "GOOGLE_LIMITED_USE.href"].every((p) => privacy.includes(p)));

console.log("The scope table matches the code");
for (const scope of Object.values(GOOGLE_SCOPES)) {
  check(`${scope} is disclosed exactly once`, GOOGLE_SCOPE_DISCLOSURES.filter((d) => d.scope === scope).length === 1);
}
check("the table discloses nothing the code does not request", GOOGLE_SCOPE_DISCLOSURES.every((d) => (Object.values(GOOGLE_SCOPES) as string[]).includes(d.scope)));
check("the privacy page renders the table", privacy.includes("GOOGLE_SCOPE_DISCLOSURES.map"));

console.log("Processors");
for (const name of ["Clerk", "Vercel", "Neon", "Stripe", "Resend", "Twilio", "Apollo", "Microsoft", "Eventbrite", "Luma", "Partiful", "Google Gemini, OpenAI, Anthropic", "Wispr Flow", "Sentry", "Slack", "Better Stack", "unavatar.io", "Microlink", "Gravatar"]) {
  check(`${name} is listed`, privacy.includes(`name: "${name}`));
}

console.log("Corrections that must not regress");
check("photos are no longer said to be discarded", !privacy.includes("then discarded"));
check("the console is no longer said to show only metadata", !privacy.includes("not the people in your"));
check("no reveal gate is claimed", !privacy.includes("reveal-everything"));
check("the recruiter scan is described", privacy.includes('id="recruiters"'));
check("the shared directory is described", privacy.includes("shared directory"));
check("self-service account deletion is described", privacy.includes("Delete your account"));
check("the usage view is pointed to", privacy.includes("Integrations → AI provider"));
check("the timeline cap is quoted from code", privacy.includes("TIMELINE_DAILY_CONTACT_CAP"));
check("the date comes from legal.ts", privacy.includes("LEGAL_LAST_UPDATED"));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll legal-page checks passed.");
process.exit(0);
