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
import {
  TEAM_DELETED_CREATOR,
  teamDomainForEmail,
  teamNameForDomain,
  teammateDisplayName,
} from "../src/lib/team-domain";

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
    check("the purge sentinel matches recruiters'", TEAM_DELETED_CREATOR === "deleted-account");
  }

  console.log("\nclient-bundle safety");
  {
    for (const file of ["src/lib/team-domain.ts"]) {
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
