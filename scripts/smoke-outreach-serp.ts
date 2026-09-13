/**
 * Search results are the raw material for every candidate. Parsing must accept the title
 * shapes LinkedIn actually produces, reject everything that is not a person's profile, and
 * never turn page chrome into a name. Query planning must always target profiles.
 *
 * Run: npx tsx scripts/smoke-outreach-serp.ts
 */
import { parseLinkedinResult, stripHtml } from "../src/lib/outreach/discovery/serp";
import { planQueries, sanitizeQuery, templateQueries } from "../src/lib/outreach/discovery/query-plan";
import type { OutreachCriteria } from "../src/lib/outreach/types";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const result = (url: string, title: string, description = "") => ({ url, title, description, extraSnippets: [] as string[] });

async function main() {
  check("stripHtml removes tags and decodes entities",
    stripHtml("<strong>Jane</strong> &amp; Co &#39;24 &#x2014; NYC") === "Jane & Co '24 — NYC");

  const three = parseLinkedinResult(result(
    "https://www.linkedin.com/in/jane-doe-123",
    "Jane Doe - Head of Partnerships - Ramp | LinkedIn",
    "Head of Partnerships at Ramp · Experience: Ramp · Location: New York · 500+ connections"
  ));
  check("three-part title: name, headline, company",
    three?.fullName === "Jane Doe" && three?.headline === "Head of Partnerships" && three?.company === "Ramp", JSON.stringify(three));
  check("location comes from the snippet", three?.location === "New York");
  check("the URL is canonical", three?.linkedinUrl === "https://www.linkedin.com/in/jane-doe-123");

  const dash = parseLinkedinResult(result("https://uk.linkedin.com/in/amir-k", "Amir Khan – Plaid | LinkedIn", "Experience: Plaid"));
  check("en-dash two-part title", dash?.fullName === "Amir Khan" && dash?.company === "Plaid", JSON.stringify(dash));

  const credential = parseLinkedinResult(result("https://linkedin.com/in/sam", "Sam Lee, MBA - VP Sales at Brex | LinkedIn"));
  check("credentials are trimmed from the name", credential?.fullName === "Sam Lee");
  check("'at Company' in a headline yields the company", credential?.company === "Brex", JSON.stringify(credential));

  check("company pages are rejected", parseLinkedinResult(result("https://www.linkedin.com/company/ramp", "Ramp | LinkedIn")) === null);
  check("posts are rejected", parseLinkedinResult(result("https://www.linkedin.com/posts/jane_x", "Jane on LinkedIn")) === null);
  check("non-LinkedIn pages are rejected", parseLinkedinResult(result("https://ramp.com/team", "Jane Doe - Ramp")) === null);
  check("page chrome is not a name", parseLinkedinResult(result("https://www.linkedin.com/in/x", "LinkedIn")) === null);

  check("sanitize adds the site operator", sanitizeQuery('"Head of Partnerships" fintech') === 'site:linkedin.com/in "Head of Partnerships" fintech');
  check("sanitize keeps an existing operator", sanitizeQuery("site:linkedin.com/in  cfo") === "site:linkedin.com/in cfo");
  check("sanitize rejects empty", sanitizeQuery("   ") === null);

  const criteria: OutreachCriteria = {
    required: [{ id: "r", kind: "role", label: "Partnerships", values: ["Head of Partnerships", "VP Partnerships"], priority: 0 }],
    preferred: [{ id: "g", kind: "geography", label: "NYC", values: ["New York"], priority: 0 }],
    exclusions: [{ id: "x", kind: "organization", label: "Banks", values: ["JPMorgan"], priority: 0 }],
  };
  const template = templateQueries(criteria, 8);
  check("template queries exist and target profiles", template.length >= 2 && template.every((q) => q.q.startsWith("site:linkedin.com/in")));
  check("template queries carry exclusions", template.every((q) => q.q.includes('-"JPMorgan"')));
  check("template respects max", templateQueries(criteria, 1).length === 1);
  check("no criteria, no queries", templateQueries({ required: [], preferred: [], exclusions: [] }, 8).length === 0);

  const brief = { purpose: "Meet partnership leads at NYC fintechs", desiredOutcome: "Intro calls" };
  const ai = await planQueries("u1", brief, criteria, 3, async (_u, input) => {
    check("planning is labelled", input.operation === "outreach.plan");
    return JSON.stringify({
      queries: [
        '"Head of Partnerships" fintech New York',
        'site:linkedin.com/in "VP Partnerships" payments',
        '"Head of Partnerships" fintech New York', // duplicate after sanitizing
        "a", // too short to find anything
        '"Partnerships Director" "New York"',
        '"Head of BD" fintech', // beyond max
      ],
    });
  });
  check("AI queries are sanitized, deduped and capped", ai.source === "ai" && ai.queries.length === 3 && ai.queries.every((q) => q.q.startsWith("site:linkedin.com/in")), JSON.stringify(ai));
  const fallback = await planQueries("u1", brief, criteria, 3, async () => {
    throw new Error("no key");
  });
  check("a failing planner falls back to templates", fallback.source === "template" && fallback.queries.length > 0);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll outreach SERP checks passed.");
}

main();
