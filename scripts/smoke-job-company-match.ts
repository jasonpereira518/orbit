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
  jobCompanyBucketKey,
  jobCompanyKeys,
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
  check(`a name under MIN_KEY_CHARS=${MIN_KEY_CHARS} has no variants to match on`, hp.variants.length === 0, JSON.stringify(hp.variants));
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
  const keys = jobCompanyKeys("Acme Technologies Group")!;
  check("variants are deduped", new Set(keys.variants).size === keys.variants.length, JSON.stringify(keys.variants));
  check("  and include the stripped form", keys.variants.includes("acme"), JSON.stringify(keys.variants));
}

console.log("\nthe bucket key: one column, and it has to work in both directions");

{
  const bucket = (name: string) => jobCompanyBucketKey(jobCompanyKeys(name)!);
  // The case a lookup-key set cannot do. `job_postings.company_key` is ONE indexed column,
  // so if the posting is filed under the longer name, no probe built from the shorter one
  // can reach it — and a feed that writes "Stripe, Inc." while the contact says "Stripe" is
  // completely ordinary. Reducing both sides first removes the direction from the problem.
  check("suffix or not, one bucket", bucket("Stripe") === bucket("Stripe, Inc."), `${bucket("Stripe")} vs ${bucket("Stripe, Inc.")}`);
  check("  spaces or not, one bucket", bucket("Capital One") === bucket("capitalone"), `${bucket("Capital One")} vs ${bucket("capitalone")}`);
  check("  and both at once", bucket("Capital One, N.A.") === bucket("capitalone"), `${bucket("Capital One, N.A.")} vs ${bucket("capitalone")}`);

  // The over-reduction this guards against. `companyFamilyKey`'s "first token of three or
  // more characters" would put these together; the cost there is two dots near each other
  // on a star map, and the cost here is telling somebody their contact works where a job
  // just opened.
  check('"Apple Bank" is not "Apple"', bucket("Apple Bank") !== bucket("Apple"));
  check('"HPE" is not "HP"', bucket("HPE") !== bucket("HP"));

  // Too short to reduce safely, so it falls back to the canonical form — the one comparison
  // `companiesMatch` allows a name that short.
  check('"HP" buckets as itself', bucket("HP") === "hp", bucket("HP"));

  // The bucket is a pre-filter; `companiesMatch` still decides. Anything sharing a bucket
  // must survive that check, or the matcher would throw away rows the index found.
  for (const [a, b] of [
    ["Stripe", "Stripe, Inc."],
    ["Capital One", "capitalone"],
    ["Capital One, N.A.", "Capital One"],
    ["HP", "HP"],
  ] as const) {
    const ka = jobCompanyKeys(a)!;
    const kb = jobCompanyKeys(b)!;
    if (bucket(a) === bucket(b)) {
      check(`  a shared bucket survives companiesMatch (${a} / ${b})`, companiesMatch(ka, kb));
    }
  }
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
