/**
 * Exercises the pure logic of the Gmail recruiter scan: payload narrowing, the
 * classifier's tolerance for messy LLM output, and the confidence floor.
 *
 * No DB and no network. The Gmail API path and the LLM call itself need real
 * credentials and are verified by running an actual scan — see the plan's
 * verification section.
 *
 * Run: npx tsx scripts/smoke-recruiter-scan.ts
 */
import {
  isGmailSenderRow,
  type ImportJobRowPayload,
} from "../src/db/schema";
import {
  RECRUITER_CONFIDENCE_FLOOR,
  recruiterScanSchema,
} from "../src/lib/recruiter-scan";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

console.log("\npayload union narrowing");
const gmailRow: ImportJobRowPayload = {
  kind: "gmail_sender",
  email: "sarah@stripe.com",
  name: "Sarah Chen",
  firm: "Stripe",
  messageIds: ["a", "b"],
};
// Shaped like a row written before the payload became a union — no `kind` at all.
const legacyLinkedInRow = {
  index: 0,
  firstName: "Ada",
  lastName: "Lovelace",
  company: "Analytical Engines",
} as ImportJobRowPayload;

check("gmail row is recognized", isGmailSenderRow(gmailRow));
check(
  "legacy LinkedIn row without a kind is not mistaken for a gmail row",
  !isGmailSenderRow(legacyLinkedInRow)
);
check(
  "narrowing exposes gmail fields",
  isGmailSenderRow(gmailRow) && gmailRow.messageIds.length === 2
);

console.log("\nclassifier schema");
const full = recruiterScanSchema.parse({
  is_recruiter: true,
  confidence: 0.9,
  full_name: "  Sarah Chen  ",
  firm: "Stripe",
  companies_mentioned: ["Stripe", "  ", "Ramp"],
  roles_discussed: ["Backend Engineer"],
  summary: "Reached out about a backend role.",
});
check("parses a well-formed response", full.is_recruiter && full.confidence === 0.9);
check(
  "blank array entries are dropped",
  full.companies_mentioned.length === 2 &&
    full.companies_mentioned.includes("Stripe") &&
    full.companies_mentioned.includes("Ramp"),
  JSON.stringify(full.companies_mentioned)
);

const sparse = recruiterScanSchema.parse({ is_recruiter: false });
check(
  "missing optional fields degrade to empty arrays, not a throw",
  sparse.companies_mentioned.length === 0 && sparse.roles_discussed.length === 0
);

const nulled = recruiterScanSchema.parse({
  is_recruiter: true,
  confidence: null,
  companies_mentioned: null,
  roles_discussed: null,
  summary: null,
});
check("explicit nulls are tolerated", nulled.companies_mentioned.length === 0);

let threw = false;
try {
  recruiterScanSchema.parse({ confidence: 0.5 });
} catch {
  threw = true;
}
check("a response missing is_recruiter is rejected", threw);

let outOfRange = false;
try {
  recruiterScanSchema.parse({ is_recruiter: true, confidence: 4 });
} catch {
  outOfRange = true;
}
check("confidence outside 0..1 is rejected", outOfRange);

console.log("\nconfidence floor");
check(
  "floor sits above a coin flip",
  RECRUITER_CONFIDENCE_FLOOR > 0.5 && RECRUITER_CONFIDENCE_FLOOR <= 1
);
const borderline = recruiterScanSchema.parse({
  is_recruiter: true,
  confidence: 0.4,
});
check(
  "a low-confidence positive is below the floor and would be dropped",
  (borderline.confidence ?? 0) < RECRUITER_CONFIDENCE_FLOOR
);

console.log("\nall recruiter scan checks passed");
