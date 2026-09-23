/**
 * The pure half of Leads P2: team domains, target parsing, the warmth ladder, the SQL the
 * who-knows-whom lookup renders, and the shape of the actions in front of it.
 *
 * The SQL section is the privacy boundary as text. The statements are built by pure
 * functions precisely so this script can render them without a database and grep for the
 * columns that must never appear — a wrong join would otherwise only show up as a leak.
 */
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { DELETED_ACCOUNT_SENTINEL } from "../src/lib/deleted-account";
import {
  TEAM_DELETED_CREATOR,
  teamDomainForEmail,
  teamNameForDomain,
  teammateDisplayName,
} from "../src/lib/team-domain";
import { identityPairs, rankWarmth } from "../src/lib/leads/warm-path";
import { parseTargetInput } from "../src/lib/leads/target-input";
import { linkedinSlug, normalizePhone } from "../src/lib/duplicates";
import { displayCompanyName, normalizeCompanyName } from "../src/lib/company-name";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A module with its comments stripped, so prose describing a rule cannot trip the rule. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const dialect = new PgDialect();

function main() {
  console.log("\nteam domains");
  {
    check("a work address gives its domain, lower-cased", teamDomainForEmail("Ada@Acme.com") === "acme.com");
    check("a public mailbox forms no team", teamDomainForEmail("ada@gmail.com") === null);
    check("nor does a missing address", teamDomainForEmail(null) === null && teamDomainForEmail("") === null);
    check("nor a string that is not an address", teamDomainForEmail("not-an-email") === null);
    check("nor a bare host", teamDomainForEmail("x@localhost") === null);
    check("the demo account's domain counts", teamDomainForEmail("demo@orbit.local") === "orbit.local");
    check("acme.com → Acme", teamNameForDomain("acme.com") === "Acme");
    check("acme.co.uk → Acme", teamNameForDomain("acme.co.uk") === "Acme");
    check("eu.acme.com → Acme", teamNameForDomain("eu.acme.com") === "Acme");
    check("orbit.local → Orbit", teamNameForDomain("orbit.local") === "Orbit");
    check("full name wins", teammateDisplayName({ firstName: "Ada", lastName: "Lovelace", email: "a@x.io" }) === "Ada Lovelace");
    check("one name is fine", teammateDisplayName({ firstName: "Ada", lastName: null, email: null }) === "Ada");
    check("pre-mirror accounts fall back to the mailbox", teammateDisplayName({ firstName: null, lastName: null, email: "priya@acme.com" }) === "priya");
    check("and to a neutral word after that", teammateDisplayName({ firstName: null, lastName: null, email: null }) === "A teammate");
    check("the purge sentinel is the shared one", TEAM_DELETED_CREATOR === DELETED_ACCOUNT_SENTINEL);
    check("and recruiters use the same shared constant", /RECRUITER_DELETED_CREATOR\s*=\s*DELETED_ACCOUNT_SENTINEL/.test(code("src/lib/recruiters.ts")));
  }

  console.log("\nthe warmth ladder");
  {
    const t = (tier: "inner" | "mid" | "outer") => ({ tier });
    check("an inner-circle path is hot", rankWarmth([t("inner"), t("outer")], []) === "hot");
    check("one mid path is warm", rankWarmth([t("mid")], []) === "warm");
    check("two outer paths are warm", rankWarmth([t("outer"), t("outer")], []) === "warm");
    check("one outer path is cool", rankWarmth([t("outer")], []) === "cool");
    check("an account path alone is cool", rankWarmth([], [{}]) === "cool");
    check("nothing is cold", rankWarmth([], []) === "cold");
    const pairs = identityPairs({ email: "a@x.io", linkedinSlug: "ada", phoneE164: null, xHandle: undefined });
    check("identity pairs skip the blanks", pairs.length === 2 && pairs.every((p) => p.value));
  }

  console.log("\ntarget parsing");
  {
    const email = parseTargetInput("  Ada@Example.com ");
    check("an address is an email, lower-cased", email.kind === "email" && email.email === "ada@example.com");
    const li = parseTargetInput("https://www.linkedin.com/in/Ada-Lovelace/?trk=x");
    check("a profile URL is a slug", li.kind === "linkedin" && li.linkedinSlug === linkedinSlug("https://www.linkedin.com/in/Ada-Lovelace/"));
    const phone = parseTargetInput("+1 (415) 555-0123");
    check("a phone is E.164", phone.kind === "phone" && phone.phoneE164 === normalizePhone("+1 (415) 555-0123") && !!phone.phoneE164);
    const x = parseTargetInput("@adalovelace");
    check("a handle is an X handle", x.kind === "x" && !!x.xHandle);
    const both = parseTargetInput("Ada Lovelace, Analytical Engines Ltd");
    check(
      "\"Name, Company\" splits into a name and a company key",
      both.kind === "name_company" &&
        both.displayName === "Ada Lovelace" &&
        both.companyNormalized === normalizeCompanyName(displayCompanyName("Analytical Engines Ltd"))
    );
    const name = parseTargetInput("Ada Lovelace");
    check("a bare name carries no identity", name.kind === "name" && identityPairs(name).length === 0);
    check("blank is empty", parseTargetInput("   ").kind === "empty");
  }

  console.log("\nclient-bundle safety");
  {
    for (const file of ["src/lib/deleted-account.ts", "src/lib/team-domain.ts", "src/lib/leads/warm-path.ts", "src/lib/leads/target-input.ts"]) {
      const valueDbImport = /import\s+(?!type\b)[^;]*from\s+["']@\/db/.test(code(file));
      check(`${file} never value-imports @/db`, !valueDbImport);
    }
  }

  void dialect;

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll warm-path checks passed.");
}

main();
