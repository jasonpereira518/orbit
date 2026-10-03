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
check(
  "it says no message body is stored and no AI reads it yet",
  /no message bod(y|ies)/i.test(privacy) && /does not send (this )?mail to an AI/i.test(privacy)
);
console.log("\nAll email-intel consent checks passed.");
