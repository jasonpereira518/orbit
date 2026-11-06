/**
 * The email-intelligence consent surface: the purpose exists, asks for the mail scope only
 * when a feature button asks, and the legal copy says what the code does.
 *
 * Pure. Run: npx tsx scripts/smoke-email-intel-consent.ts
 */
import { readFileSync } from "node:fs";
import {
  GOOGLE_CONNECT_PURPOSES,
  GOOGLE_SCOPES,
  googleScopesFor,
  isGooglePurpose,
  requiredScopeFor,
} from "../src/lib/google-scopes";
import { GOOGLE_SCOPE_DISCLOSURES, TERMS_VERSION } from "../src/lib/legal";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

check("email_intel is a Google purpose", isGooglePurpose("email_intel"));
check("it needs the Gmail read scope", requiredScopeFor("email_intel") === GOOGLE_SCOPES.gmailRead);
check(
  "asking for it requests gmail.readonly",
  googleScopesFor(["email_intel"]).includes(GOOGLE_SCOPES.gmailRead)
);
check("everyday Connect never asks for mail", !(GOOGLE_CONNECT_PURPOSES as readonly string[]).includes("email_intel"));

const gmailRow = GOOGLE_SCOPE_DISCLOSURES.find((r) => r.scope === GOOGLE_SCOPES.gmailRead);
check("the Gmail scope disclosure names the feature", /email insights/i.test(gmailRow?.use ?? ""));
check("and still promises no stored bodies", /never stored/i.test(gmailRow?.use ?? ""));
check("the terms version moved off 2026-09-29", String(TERMS_VERSION) !== "2026-09-29", TERMS_VERSION);

// Whitespace-collapsed, like smoke-legal-pages: JSX wraps prose across lines.
const privacy = readFileSync("src/app/(site)/(docs)/privacy/page.tsx", "utf8").replace(/\s+/g, " ");
check("the privacy page has an Email insights callout", /title="Email insights"/.test(privacy));
check("the privacy page still says no bodies are stored", /no message bod(y|ies)/i.test(privacy));
check("it names what is sent to the AI provider", /sends it, with the sender names and addresses, to the AI provider/i.test(privacy));
check("it states the limits on what is read", /up to four, each cut to 4,000 characters/i.test(privacy));
check("it states the evidence quote limit", /under 200 characters/i.test(privacy));
check("it no longer claims the mail never reaches an AI provider", !/does not send this mail to an AI provider/i.test(privacy));
check("it disclaims training and advertising", /does not use this mail to train models or for advertising/i.test(privacy));
check("the Gmail disclosure names the AI provider", /AI provider/i.test(gmailRow?.use ?? ""));
check("the privacy page says the notes can appear on Radar", /can appear as reasons on your Radar cards/i.test(privacy));
check("and that they stay out of the Monday email", /never put in Radar(&rsquo;|’|')s Monday email/i.test(privacy));
check("the Gmail disclosure says so too", /can appear on your Radar cards/i.test(gmailRow?.use ?? ""));
console.log("\nAll email-intel consent checks passed.");
