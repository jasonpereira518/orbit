/**
 * The legal pages must say what the code does. This reads their source and pins the
 * statements Google verification and the audit (A3) require, the corrections that must not
 * regress, and the link between the Google scope table and the scopes the code requests.
 *
 * It also holds a LOCK over the two page sources, in the shape of `schema-ddl.lock.json`:
 * `legal-pages.lock.json` records a hash of both pages beside the LEGAL_LAST_UPDATED and
 * TERMS_VERSION they were last published under. The checks above only prove the date is
 * SOURCED from legal.ts, never that it moved, so a rewrite of the consent model could ship
 * under a stale date with re-consent dormant and a green suite. The lock is what says no.
 *
 * Deliberately unforgiving: the hash is of the whole file, whitespace-collapsed, so any edit
 * to either page — prose, markup, even a comment — counts until someone confirms the date
 * moved with it. These are the documents people are held to; a false alarm costs one command.
 *
 * Pure. Run:    npx tsx scripts/smoke-legal-pages.ts
 *       Update: npx tsx scripts/smoke-legal-pages.ts --update
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import {
  GOOGLE_LIMITED_USE,
  GOOGLE_LIMITED_USE_SENTENCE,
  GOOGLE_SCOPE_DISCLOSURES,
  LEGAL_LAST_UPDATED,
  TERMS_VERSION,
} from "../src/lib/legal";

const privacy = readFileSync("src/app/(site)/(docs)/privacy/page.tsx", "utf8");
const terms = readFileSync("src/app/(site)/(docs)/terms/page.tsx", "utf8");

const LOCK = path.join(process.cwd(), "scripts", "legal-pages.lock.json");

/** Both page sources, whitespace-collapsed so an indentation change alone is not a rewrite. */
const fingerprint = crypto
  .createHash("sha256")
  .update([terms, privacy].map((s) => s.replace(/\s+/g, " ").trim()).join("\n--\n"))
  .digest("hex");

if (process.argv.includes("--update")) {
  writeFileSync(
    LOCK,
    JSON.stringify(
      { lastUpdated: LEGAL_LAST_UPDATED, termsVersion: TERMS_VERSION, fingerprint },
      null,
      2
    ) + "\n"
  );
  console.log(
    `legal-pages: lock updated to ${LEGAL_LAST_UPDATED} / ${TERMS_VERSION} (${fingerprint.slice(0, 12)})`
  );
  process.exit(0);
}

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
for (const name of ["Clerk", "Vercel", "Neon", "Stripe", "Resend", "Twilio", "Apollo", "Microsoft", "Eventbrite", "Luma", "Partiful", "Google Gemini, OpenAI, Anthropic", "Sentry", "Slack", "Better Stack", "unavatar.io", "Microlink", "Gravatar"]) {
  check(`${name} is listed`, privacy.includes(`name: "${name}`));
}

console.log("Microsoft");
check("Outlook mail is no longer said to go unread", !privacy.includes("Orbit does not read Outlook mail"));
check("Microsoft is no longer said to be contacts-only", !privacy.includes("used only to import Outlook contacts"));
check("the Microsoft row names contacts, calendar and mail", /name: "Microsoft"[^\n]*contacts[^\n]*calendar[^\n]*mail/.test(privacy));
check("Microsoft permissions are described as read-only and per feature", privacy.includes("one read-only permission per feature you turn on"));
check("the Outlook recruiter scan is described", privacy.includes("<strong>Outlook.</strong>"));

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

console.log("Terms");
check("subscriptions are no longer said to run through Clerk", !terms.includes("Clerk&apos;s billing") && !terms.includes("Clerk's billing"));
check("billing is said to run through Stripe", terms.includes("Payments are handled by Stripe"));
check("refunds and chargebacks end access", terms.includes("Refunds and chargebacks end what they paid for"));
check("account deletion from Settings is described", terms.includes("delete your account yourself"));
check("the Terms date comes from legal.ts", terms.includes("LEGAL_LAST_UPDATED"));
check("the timeline cap is quoted from code", terms.includes("TIMELINE_DAILY_CONTACT_CAP"));

console.log("The published version moved with the text");

type LegalLock = { lastUpdated: string; termsVersion: string; fingerprint: string };
let lock: LegalLock | null = null;
try {
  lock = JSON.parse(readFileSync(LOCK, "utf8")) as LegalLock;
} catch {
  lock = null;
}

const REMEDY = "        npx tsx scripts/smoke-legal-pages.ts --update";

if (!lock) {
  check("the lock exists", false, `no ${path.basename(LOCK)} — create it with:\n${REMEDY}`);
} else if (lock.fingerprint !== fingerprint) {
  const stale: string[] = [];
  if (lock.lastUpdated === LEGAL_LAST_UPDATED) stale.push("LEGAL_LAST_UPDATED");
  if (lock.termsVersion === TERMS_VERSION) stale.push("TERMS_VERSION");
  if (stale.length > 0) {
    check(
      "the pages changed and the version moved with them",
      false,
      `/terms or /privacy changed but ${stale.join(" and ")} did not.\n\n` +
        `        recorded: ${lock.lastUpdated} / ${lock.termsVersion}  ${lock.fingerprint.slice(0, 12)}\n` +
        `        current:  ${LEGAL_LAST_UPDATED} / ${TERMS_VERSION}  ${fingerprint.slice(0, 12)}\n\n` +
        "  Both pages render Last updated from LEGAL_LAST_UPDATED, so this text would ship\n" +
        "  under a stale date. needsTermsAcceptance() compares the recorded acceptance against\n" +
        "  TERMS_VERSION, so leaving it still makes shouldShowTermsNotice() false for every\n" +
        "  existing account and the \u201cWe\u2019ve updated our Terms and Privacy Policy\u201d notice never\n" +
        "  fires \u2014 and user_settings.terms_version records the old version for accounts that\n" +
        "  only ever saw the new text. Set both in src/lib/legal.ts to today\u2019s date, then:\n" +
        REMEDY
    );
  } else {
    check(
      "the lock records the published text",
      false,
      `the pages, LEGAL_LAST_UPDATED and TERMS_VERSION all moved, but the lock is stale. Record it with:\n${REMEDY}`
    );
  }
} else if (lock.lastUpdated !== LEGAL_LAST_UPDATED || lock.termsVersion !== TERMS_VERSION) {
  check(
    "the lock records the published version",
    false,
    `the version moved (${lock.lastUpdated} / ${lock.termsVersion} \u2192 ${LEGAL_LAST_UPDATED} / ${TERMS_VERSION}) with no change to either page. ` +
      `If that was deliberate, record it with:\n${REMEDY}`
  );
} else {
  check(`both pages match the text published as ${LEGAL_LAST_UPDATED} (${TERMS_VERSION})`, true);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll legal-page checks passed.");
process.exit(0);
