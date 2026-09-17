/**
 * Company matching for the job feed.
 *
 * This decides whether a posting gets pushed at somebody, so it is tuned to be WRONG IN THE
 * QUIET DIRECTION: a missed match costs one notification nobody sees, a false match tells
 * someone their contact works where a job just opened when they do not.
 *
 * The three near-misses that motivated a dedicated module are all asserted below:
 * `normalizeCompanyKey` alone does not collide "Capital One" with "capitalone",
 * `companyFamilyKey` alone happily collides "Apple Bank" with "Apple", and a similarity
 * score would collide "Stripe" with "Strive".
 *
 * Run: npx tsx scripts/smoke-job-company-match.ts
 */

import {
  MIN_KEY_CHARS,
  companiesMatch,
  jobCompanyKeys,
  lookupKeysFor,
} from "../src/lib/jobs/company-match";
import {
  DEFAULT_JOB_FEEDS,
  SIMPLIFY_FEED_BRANCH,
  simplifyFeedUrl,
} from "../src/lib/jobs/feed-sources";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function match(a: string, b: string) {
  const ka = jobCompanyKeys(a);
  const kb = jobCompanyKeys(b);
  return Boolean(ka && kb && companiesMatch(ka, kb));
}

console.log("\nthe same employer, written differently");

{
  const pairs: Array<[string, string]> = [
    ["Capital One", "Capital One"],
    ["Capital One", "Capital One, N.A."],
    ["Capital One", "capitalone"],
    ["Capital One, N.A.", "capitalone"],
    ["Stripe", "Stripe, Inc."],
    ["Acme Technologies Group", "Acme"],
    ["Palantir Technologies", "Palantir"],
    ["  DATABRICKS  ", "Databricks"],
    ["Jane Street Capital", "jane street capital"],
  ];
  for (const [a, b] of pairs) {
    check(`"${a}" ≈ "${b}"`, match(a, b));
  }
}

// The existing alias table is reused rather than re-stated, so AWS keeps working.
check('"AWS" ≈ "Amazon Web Services"', match("AWS", "Amazon Web Services"));

console.log("\ndifferent employers that look alike");

{
  const pairs: Array<[string, string]> = [
    // The `companyFamilyKey` failure: its "first token ≥3 chars" fallback collides these.
    ["Apple", "Apple Bank"],
    ["Stripe", "Strive"],
    ["HP", "HPE"],
    ["Meta", "MetaMask"],
    ["Square", "Squarespace"],
    ["Notion", "Nation"],
    ["Ramp", "Rampart"],
  ];
  for (const [a, b] of pairs) {
    check(`"${a}" ≠ "${b}"`, !match(a, b), "matched when it should not have");
  }
}

console.log("\nshort keys never match loosely");

// "hp", "ey", "x" and "ai" are real company names AND substrings of half a job feed. They
// may only ever match an exact primary, never through the stripped or collapsed aliases.
{
  check('"HP" ≈ "HP"', match("HP", "HP"));
  check('"EY" ≈ "EY"', match("EY", "EY"));
  check('"X" ≠ "Xero"', !match("X", "Xero"));
  const hp = jobCompanyKeys("HP")!;
  check(`short keys are dropped from lookups (MIN_KEY_CHARS=${MIN_KEY_CHARS})`, lookupKeysFor(hp).length === 1, JSON.stringify(lookupKeysFor(hp)));
}

console.log("\nkey sets");

{
  const k = jobCompanyKeys("Capital One, N.A.")!;
  check("primary is normalised", k.primary === "capital one n a", k.primary);
  check("  stripped drops the legal suffix", k.stripped === "capital one", String(k.stripped));
  check("  collapsed removes spaces", k.collapsed === "capitalonena", k.collapsed);
  const simple = jobCompanyKeys("Stripe")!;
  check("a name with nothing to strip has null stripped", simple.stripped === null);
  check("empty input has no keys", jobCompanyKeys("") === null);
  check("null input has no keys", jobCompanyKeys(null) === null);
  check("punctuation-only input has no keys", jobCompanyKeys("  ,. ") === null);
}

{
  const keys = lookupKeysFor(jobCompanyKeys("Acme Technologies Group")!);
  check("lookup keys are deduped", new Set(keys).size === keys.length, JSON.stringify(keys));
  check("  and include the stripped form", keys.includes("acme"), JSON.stringify(keys));
}

console.log("\nthe feed URL");

// `main` 404s. This is the single most likely thing for somebody to "fix" later.
check("the branch is dev", SIMPLIFY_FEED_BRANCH === "dev");
check("  and the URL says so", simplifyFeedUrl("Summer2027-Internships").includes("/dev/"));
check("  and never main", !simplifyFeedUrl("Summer2027-Internships").includes("/main/"));
check(
  "  and points at the generated JSON",
  simplifyFeedUrl("X").endsWith("/.github/scripts/listings.json"),
  simplifyFeedUrl("X")
);
check("the default feed is https", DEFAULT_JOB_FEEDS.every((f) => f.url.startsWith("https://")));
check("  with a season to match on", DEFAULT_JOB_FEEDS.every((f) => f.season.trim().length > 0));
check("  and unique ids", new Set(DEFAULT_JOB_FEEDS.map((f) => f.id)).size === DEFAULT_JOB_FEEDS.length);

console.log("\nAll job company-match checks passed.");
