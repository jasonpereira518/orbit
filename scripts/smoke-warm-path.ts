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
import { linkedinSlug, normalizePhone, identityKeysFor } from "../src/lib/duplicates";
import { displayCompanyName, normalizeCompanyName } from "../src/lib/company-name";
import {
  coerceLeadInput,
  LEAD_FIELD_MAX,
  leadTargetIdentity,
  normalizeLeadInput,
} from "../src/lib/leads/lead-identity";
import { introRequestMailto } from "../src/lib/leads/intro-request";
import { isLeadStatus, isUuid, LEAD_STATUSES } from "../src/lib/leads/validate";
import { accountPathsStatement, directPathsStatement } from "../src/lib/leads/warm-path-sql";

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

  console.log("\nthe SQL is the privacy boundary");
  {
    const direct = dialect.sqlToQuery(
      directPathsStatement("team-1", "viewer-1", [
        { key: "k1", kind: "email", value: "ada@x.io" },
        { key: "k1", kind: "linkedin_slug", value: "ada" },
      ])
    );
    const account = dialect.sqlToQuery(
      accountPathsStatement(
        "team-1",
        "viewer-1",
        [{ key: "k1", company: "acme" }],
        [{ key: "k1", kind: "email", value: "ada@x.io" }]
      )
    );
    // The exact bind count for the inputs each call above passes: 2 targets * 3 values + the
    // mate CTE's (team, viewer) for direct; 1 company target * 2 + the mate CTE's 2 + 1
    // excluded identity * 3 for account.
    const expectedParams: Record<string, number> = { direct: 8, account: 7 };
    for (const [label, q] of [["direct", direct], ["account", account]] as const) {
      const text = q.sql;
      check(`${label}: only sharing teammates`, /share_network\s*=\s*1/.test(text));
      check(`${label}: only shared contacts`, /team_shared\s*=\s*1/.test(text));
      check(`${label}: never the viewer`, /tm\.user_id\s*<>\s*\$\d+/.test(text));
      check(`${label}: every contact join is tenant-scoped`, /c\.user_id\s*=\s*(ci|co)\.user_id/.test(text));
      check(`${label}: no correlated exists`, !/exists\s*\(/i.test(text));
      const forbidden = /\bnotes\b|ai_summary|key_facts|\bc\.email\b|\bc\.phone\b|linkedin_url|\bc\.full_name\b/;
      check(`${label}: names no private column`, !forbidden.test(text), text.match(forbidden)?.[0]);
      check(
        `${label}: binds exactly its inputs`,
        q.params.length === expectedParams[label],
        String(q.params.length)
      );

      // Every CTE-internal `from` in this file is written indented (`    from team_members
      // tm`, `  from contact_identities x`); only the outer query's own FROM starts a line
      // with no leading space, so `\nfrom ` finds it uniquely. That is the real SELECT/FROM
      // boundary — a naive "first ` from `" substring match lands inside the `mate` CTE
      // instead (it comes first in the text) and would never see the outer projection at
      // all, making the check below vacuous.
      const fromAt = text.indexOf("\nfrom ");
      check(`${label}: has an outer FROM to split the projection on`, fromAt !== -1);
      const head = text.slice(0, fromAt);
      const strayColumn = /\bc\.(?!closeness_tier\b)\w+/;
      check(
        `${label}: projects no c. column but closeness_tier`,
        !strayColumn.test(head),
        head.match(strayColumn)?.[0]
      );
      check(`${label}: projects no teammate contact id`, !/\bci\.contact_id\b|\bc\.id\b/.test(head));
    }
    check("direct paths collapse to one row per teammate", /distinct on \(t\.target_key, m\.user_id\)/.test(direct.sql));
    check("account paths group per teammate", /group by t\.target_key, m\.user_id/.test(account.sql));
    check("account paths anti-join the target's own identities via a hit CTE", /\bhit\s+as\s*\(/.test(account.sql));
    check("...excluding a contact once it has matched, not per non-matching identity", /h\.contact_id is null/.test(account.sql));
    check("...still no correlated exists", !/exists\s*\(/i.test(account.sql));

    const throwsOnEmpty = (fn: () => unknown) => {
      try {
        fn();
        return false;
      } catch (e) {
        return e instanceof Error && e.message === "warm-path: empty target list";
      }
    };
    check(
      "directPathsStatement refuses an empty target list",
      throwsOnEmpty(() => directPathsStatement("team-1", "viewer-1", []))
    );
    check(
      "accountPathsStatement refuses an empty target list",
      throwsOnEmpty(() => accountPathsStatement("team-1", "viewer-1", [], []))
    );
  }

  console.log("\nthe actions in front of it");
  {
    const source = code("src/actions/teams.ts");
    check("is a server module", /^\s*"use server";/m.test(readFileSync("src/actions/teams.ts", "utf8")));
    const exports = [...source.matchAll(/^export\s+(async\s+)?function\s+(\w+)/gm)];
    check("every export is an async function", exports.length >= 7 && exports.every((m) => !!m[1]), String(exports.length));
    check("no type re-exports (they break a use-server module)", !/^export\s+type\s*\{/m.test(source));
    const bodies = source.split(/^export\s+async\s+function\s+/m).slice(1);
    check("every action gates on requireLeadsUser first", bodies.every((b) => /^[^{]*\{\s*const userId = await requireLeadsUser\(\);/.test(b)));
  }

  console.log("\nleads are written the way contact identities are");
  {
    const raw = {
      email: " Ada@Example.COM ",
      linkedinUrl: "https://www.linkedin.com/in/Ada-Lovelace/?trk=x",
      phone: "+1 (415) 555-0123",
    };
    const lead = normalizeLeadInput({
      displayName: "  Ada Lovelace ",
      ...raw,
      companyName: "  Analytical   Engines Ltd ",
      title: "Mathematician",
    });
    const keys = identityKeysFor(raw);
    const key = (kind: string) => keys.find((k) => k.kind === kind)?.value ?? null;
    check("the name is trimmed", lead.displayName === "Ada Lovelace");
    check("the email is its identity key", lead.emailNormalized === key("email") && lead.emailNormalized === "ada@example.com");
    check("the raw email is kept as typed, trimmed", lead.email === "Ada@Example.COM");
    check("the LinkedIn slug is its identity key", !!lead.linkedinSlug && lead.linkedinSlug === key("linkedin_slug"));
    check("the phone is its identity key", !!lead.phoneE164 && lead.phoneE164 === key("phone_e164"));
    check(
      "the company key is resolveCompany's",
      lead.companyNormalized === normalizeCompanyName(displayCompanyName("Analytical   Engines Ltd"))
    );
    const role = normalizeLeadInput({ displayName: "Sales", email: "sales@acme.test" });
    check("a role mailbox is kept but never matched", role.email === "sales@acme.test" && role.emailNormalized === null);
    const bare = normalizeLeadInput({ displayName: "Grace", email: "  ", companyName: "" });
    check("blanks are null", bare.email === null && bare.companyNormalized === null && bare.linkedinSlug === null);
    const target = leadTargetIdentity(lead);
    check(
      "a lead's target carries its identifiers and company",
      target.email === lead.emailNormalized &&
        target.linkedinSlug === lead.linkedinSlug &&
        target.phoneE164 === lead.phoneE164 &&
        target.companyNormalized === lead.companyNormalized
    );
    check("a long paste is cut to the field limit", normalizeLeadInput({ displayName: "x".repeat(500) }).displayName.length === LEAD_FIELD_MAX);
    const forged = coerceLeadInput({ displayName: 42, email: ["a@b.c"], title: "CTO" });
    check("forged input keeps only strings", forged.displayName === "" && forged.email === null && forged.title === "CTO");
    check("a missing body is an empty lead", coerceLeadInput(null).displayName === "");
  }

  console.log("\nthe intro ask");
  {
    const url = introRequestMailto({
      teammateName: "Alex Ng",
      teammateEmail: "alex@acme.test",
      leadName: "Jane Doe",
      leadCompany: "Northwind",
    });
    check("is a mailto to the teammate", url.startsWith("mailto:alex%40acme.test?"), url);
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    check("asks for the intro by name", params.get("subject") === "Intro to Jane Doe?");
    check("greets the teammate by first name", (params.get("body") ?? "").startsWith("Hi Alex,"));
    check("names the company when known", (params.get("body") ?? "").includes("Jane Doe at Northwind"));
    const noCompany = new URLSearchParams(
      introRequestMailto({ teammateName: "Priya", teammateEmail: "p@acme.test", leadName: "Sam", leadCompany: null }).split("?")[1]
    );
    check("and leaves it out when not", (noCompany.get("body") ?? "").includes("you know Sam."));
  }

  console.log("\ninput checks");
  {
    check("a uuid passes", isUuid("0f8fad5b-d9cb-469f-a165-70867728950e"));
    check("anything else fails", !isUuid("1; drop table leads") && !isUuid(42) && !isUuid(undefined));
    check("the four statuses, in order", LEAD_STATUSES.join(",") === "open,intro_requested,converted,dismissed");
    check("an unknown status fails", !isLeadStatus("won") && isLeadStatus("dismissed"));
  }

  console.log("\nclient-bundle safety");
  {
    for (const file of ["src/lib/deleted-account.ts", "src/lib/team-domain.ts", "src/lib/leads/warm-path.ts", "src/lib/leads/target-input.ts", "src/lib/leads/warm-path-sql.ts", "src/lib/leads/lead-identity.ts", "src/lib/leads/intro-request.ts", "src/lib/leads/validate.ts"]) {
      const valueDbImport = /import\s+(?!type\b)[^;]*from\s+["']@\/db/.test(code(file));
      check(`${file} never value-imports @/db`, !valueDbImport);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll warm-path checks passed.");
}

main();
