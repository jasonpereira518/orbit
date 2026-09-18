/**
 * Guards "who do I already know at this company" — the answer Orbit could always have given
 * and never did.
 *
 * `contact_experiences` has carried an index on `(user_id, organization_normalized)` since it
 * shipped, and until now the only readers were the settings export and the profile display.
 * Outreach drafted cold emails to strangers at companies where the user already had a former
 * colleague and said nothing about it.
 *
 * The checks below fix the two decisions that make this useful rather than merely present:
 * that BOTH evidence sources are read (an experience row and a plain `contacts.company`,
 * because a LinkedIn CSV import produces only the second), and that one person is never
 * listed twice for one company.
 *
 * Run: npx tsx scripts/smoke-warm-paths.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { companies, contactExperiences, contacts } from "../src/db/schema";
import { findWarmPaths } from "../src/lib/warm-paths-server";
import { orgKeysFor, rankWarmPaths, type WarmPathCandidate } from "../src/lib/warm-paths";
import { normalizeCompanyKey } from "../src/lib/company-name";

const USER = "smoke-warm-paths-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

const cand = (over: Partial<WarmPathCandidate>): WarmPathCandidate => ({
  contactId: "c1",
  fullName: "Someone",
  orgKey: "stripe",
  orgLabel: "Stripe",
  reason: "listed_there",
  ...over,
});

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(companies).where(eq(companies.userId, USER));

  section("Org keys are normalised the way the stored column was");

  check("punctuation and case collapse", orgKeysFor(["Stripe, Inc."])[0] === normalizeCompanyKey("Stripe, Inc."));
  check("duplicates collapse", orgKeysFor(["Stripe", "stripe", "STRIPE"]).length === 1);
  check("blanks are dropped", orgKeysFor(["", "   ", null, undefined]).length === 0);

  section("Ranking: a former colleague outranks a current one");

  const ranked = rankWarmPaths([
    cand({ contactId: "now", fullName: "Nadia Now", reason: "works_there", closeness: 50 }),
    cand({ contactId: "past", fullName: "Pia Past", reason: "worked_there", closeness: 50, startYear: 2019, endYear: 2022 }),
    cand({ contactId: "csv", fullName: "Cal Csv", reason: "listed_there", closeness: 99 }),
  ]);
  const stripe = ranked.get("stripe") ?? [];
  check(
    "the person who left is first",
    stripe[0]?.contactId === "past",
    `got ${JSON.stringify(stripe.map((p) => p.contactId))} — they can speak freely about the place`
  );
  check("then the current employee", stripe[1]?.contactId === "now");
  check(
    "a bare CSV company ranks last even at high closeness",
    stripe[2]?.contactId === "csv",
    "a company string with no dates behind it may be years stale"
  );
  check(
    "a past role reads with its dates",
    stripe[0]?.reasonLabel === "worked there 2019-2022",
    `got ${JSON.stringify(stripe[0]?.reasonLabel)}`
  );
  check(
    "and degrades when the dates are missing",
    (rankWarmPaths([cand({ reason: "worked_there" })]).get("stripe") ?? [])[0]?.reasonLabel ===
      "worked there"
  );

  section("Closeness breaks ties, not the raw import default");

  const byCloseness = rankWarmPaths([
    cand({ contactId: "far", fullName: "Far", reason: "works_there", closeness: 10, relationshipScore: 5 }),
    cand({ contactId: "near", fullName: "Near", reason: "works_there", closeness: 90, relationshipScore: 2 }),
  ]).get("stripe");
  check(
    "the closer contact wins despite a lower raw score",
    byCloseness?.[0]?.contactId === "near",
    "relationshipScore defaults to 2 for a whole import, so ranking by it ranks by nothing"
  );

  section("One person is never listed twice for one company");

  const deduped = rankWarmPaths([
    cand({ contactId: "same", fullName: "Same Person", reason: "listed_there" }),
    cand({ contactId: "same", fullName: "Same Person", reason: "works_there" }),
    cand({ contactId: "same", fullName: "Same Person", reason: "worked_there", endYear: 2021 }),
  ]).get("stripe");
  check("three rows, one entry", deduped?.length === 1, `got ${deduped?.length}`);
  check(
    "and it keeps the strongest claim",
    deduped?.[0]?.reason === "worked_there",
    `got ${deduped?.[0]?.reason}`
  );

  section("Against the database: both evidence sources are read");

  // The Apollo/profile-capture shape: an experience row.
  const [former] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Former Colleague", relationshipScore: 3 })
    .returning();
  await db.insert(contactExperiences).values({
    userId: USER,
    contactId: former.id,
    kind: "role",
    organization: "Stripe",
    organizationNormalized: normalizeCompanyKey("Stripe"),
    title: "Staff Engineer",
    startYear: 2019,
    endYear: 2022,
    isCurrent: false,
    source: "apollo",
  });

  // The overwhelmingly common shape: a LinkedIn CSV import, company only, no experiences.
  const [co] = await db
    .insert(companies)
    .values({ userId: USER, name: "Stripe", nameNormalized: normalizeCompanyKey("Stripe") })
    .returning();
  const [csvPerson] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Csv Import",
      company: "Stripe",
      companyId: co.id,
      relationshipScore: 2,
    })
    .returning();

  // Somebody at an entirely different company must not appear.
  await db.insert(contacts).values({ userId: USER, fullName: "Unrelated Person" });

  const paths = await findWarmPaths(USER, orgKeysFor(["stripe"]));
  const found = paths.get(normalizeCompanyKey("Stripe")) ?? [];
  check(
    "both sources answer for the same company",
    found.length === 2,
    `got ${found.length}: ${JSON.stringify(found.map((p) => p.fullName))}`
  );
  check(
    "the former colleague is found through contact_experiences",
    found.some((p) => p.contactId === former.id && p.reason === "worked_there")
  );
  check(
    "the CSV-imported contact is found through contacts.company",
    found.some((p) => p.contactId === csvPerson.id && p.reason === "listed_there"),
    "this is the source a freshly-imported network actually has"
  );
  check("and the former colleague ranks first", found[0]?.contactId === former.id);
  check(
    "nobody unrelated appears",
    !found.some((p) => p.fullName === "Unrelated Person")
  );

  section("A known limit, pinned so it cannot surprise anyone later");

  // `normalizeCompanyKey` strips punctuation and case but NOT legal suffixes, so "Stripe"
  // and "Stripe, Inc." are different keys. That is not this feature's choice — it is how
  // company identity already works everywhere in Orbit (`companies.name_normalized` is the
  // unique key), so widening it here would silently disagree with every existing grouping
  // and re-key the companies table. Asserted rather than left implicit: a campaign that
  // names a target company with its legal suffix will not find connectors filed under the
  // short name, and fixing that is a change to the normaliser and a migration, not a patch
  // here.
  check(
    "a legal suffix produces a different key",
    normalizeCompanyKey("Stripe, Inc.") !== normalizeCompanyKey("Stripe"),
    `"${normalizeCompanyKey("Stripe, Inc.")}" vs "${normalizeCompanyKey("Stripe")}"`
  );
  check(
    "so the suffixed spelling finds nobody, today",
    ((await findWarmPaths(USER, orgKeysFor(["Stripe, Inc."]))).get("stripe inc") ?? []).length === 0
  );

  section("Refusals");

  check("no org keys means no query", (await findWarmPaths(USER, [])).size === 0);
  check(
    "a company nobody is connected to is absent, not empty",
    !(await findWarmPaths(USER, orgKeysFor(["Nobody Corp"]))).has("nobody corp"),
    "absent and present-but-empty must be distinguishable by the caller"
  );
  check(
    "another user sees none of this",
    (await findWarmPaths("someone-else", orgKeysFor(["Stripe"]))).size === 0
  );

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(companies).where(eq(companies.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll warm-path checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
