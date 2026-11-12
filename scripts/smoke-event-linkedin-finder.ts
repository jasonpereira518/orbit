import assert from "node:assert/strict";
import { normalizeLinkedInUrl } from "../src/lib/events/linkedin-finder";

console.log("\nnormalizing and validating LinkedIn profile URLs");

const validCases: Array<[string, string]> = [
  ["https://www.linkedin.com/in/satyanadella", "https://www.linkedin.com/in/satyanadella"],
  ["https://linkedin.com/in/satyanadella/", "https://www.linkedin.com/in/satyanadella"],
  ["http://www.linkedin.com/in/jason-pereira-123", "https://www.linkedin.com/in/jason-pereira-123"],
  ["linkedin.com/in/sam-altman", "https://www.linkedin.com/in/sam-altman"],
  ["www.linkedin.com/in/demishassabis", "https://www.linkedin.com/in/demishassabis"],
  ["https://ca.linkedin.com/in/geoffreyhinton", "https://www.linkedin.com/in/geoffreyhinton"],
  ["[Profile](https://www.linkedin.com/in/satyanadella)", "https://www.linkedin.com/in/satyanadella"],
  ["<https://www.linkedin.com/in/satyanadella>", "https://www.linkedin.com/in/satyanadella"],
  ["https://www.linkedin.com/in/satyanadella?utm_source=share", "https://www.linkedin.com/in/satyanadella"],
];

for (const [input, expected] of validCases) {
  const normalized = normalizeLinkedInUrl(input);
  assert.equal(normalized, expected, `Failed for input: ${input}`);
  console.log(`  ok    ${input} -> ${expected}`);
}

console.log("\nrejecting invalid or non-profile URLs");

const invalidCases = [
  "",
  "   ",
  "https://twitter.com/satyanadella",
  "https://linkedin.com/company/google",
  "https://linkedin.com/feed/",
  "https://linkedin.com/jobs/view/123",
  "https://phishing-linkedin.com/in/victim",
  "random text string",
];

for (const input of invalidCases) {
  const result = normalizeLinkedInUrl(input);
  assert.equal(result, null, `Should have rejected: ${input}`);
  console.log(`  ok    rejected invalid URL: "${input}"`);
}

console.log("\nverifying finder exports and signatures");
import { findAttendeeLinkedIn, batchFindRosterLinkedIns } from "../src/lib/events/linkedin-finder";
assert.equal(typeof findAttendeeLinkedIn, "function");
assert.equal(typeof batchFindRosterLinkedIns, "function");
console.log("  ok    findAttendeeLinkedIn and batchFindRosterLinkedIns exported");

console.log("\nAll LinkedIn finder checks passed.");
