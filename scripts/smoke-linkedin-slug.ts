/**
 * `linkedinSlug()` agrees with the `linkedin_slug` generated column, including on LinkedIn
 * URLs that are not a profile.
 *
 * Pins the fix in src/lib/duplicates.ts: the function used to fall back to the whole
 * normalised URL when there was no `/in/<slug>`, while the column
 * (LINKEDIN_SLUG_EXPRESSION in src/db/index.ts) stores NULL. That non-empty fallback gave a
 * company or school page a `linkedin_slug` identity key, so two different people pasted with
 * their employer's page matched "Same LinkedIn URL" at 0.98 — above
 * DUPLICATE_MERGE_CONFIDENCE — and were merged automatically. It now returns "".
 *
 * pglite tier: the column expression is evaluated by Postgres itself, so this pins the
 * function and the column against each other rather than against a copy of the rule.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, LINKEDIN_SLUG_EXPRESSION, rowsOf } from "../src/db";
import {
  DUPLICATE_MERGE_CONFIDENCE,
  findDuplicateCandidatesIndexed,
  buildDuplicateIndex,
  identityKeysFor,
  linkedinSlug,
} from "../src/lib/duplicates";
import { checker } from "./smoke/check";
import { makeContact } from "./smoke/factories";

const t = checker();

/** What the generated column stores for `url` ("" for NULL), computed by Postgres. */
async function columnSlug(url: string): Promise<string> {
  const db = await getDb();
  const res = await db.execute(
    sql`SELECT ${sql.raw(LINKEDIN_SLUG_EXPRESSION)} AS slug FROM (SELECT ${url}::text AS linkedin_url) AS t`
  );
  return rowsOf<{ slug: string | null }>(res)[0]?.slug ?? "";
}

run(async () => {
  console.log("\nprofile URLs: the function and the column agree");
  for (const url of [
    "https://www.linkedin.com/in/ada-lovelace-0",
    "https://uk.linkedin.com/in/Ada-Lovelace-0/",
    "linkedin.com/in/ada-lovelace-0?trk=public_profile",
    "https://www.linkedin.com/in/ada-lovelace-0#about",
  ]) {
    const fn = linkedinSlug(url);
    const col = await columnSlug(url);
    t.check(`${url} → "${fn}"`, fn === col && fn === "ada-lovelace-0", `column "${col}"`);
  }

  console.log("\nnon-profile LinkedIn URLs: the column stores NULL, so the function must return \"\"");
  const nonProfile = [
    "https://www.linkedin.com/company/acme-analytics",
    "https://www.linkedin.com/school/springfield-university/",
    "https://www.linkedin.com/in/",
    "https://www.linkedin.com/",
  ];
  for (const url of nonProfile) {
    const fn = linkedinSlug(url);
    const col = await columnSlug(url);
    t.check(`column stores NULL for ${url}`, col === "");
    t.check(`linkedinSlug(${url}) agrees with the generated column`, fn === col, `function "${fn}", column "${col}"`);
  }

  console.log("\ntwo different people sharing their employer's company page");
  const companyPage = "https://www.linkedin.com/company/acme-analytics";
  const ada = { ...makeContact(0), id: "00000000-0000-4000-8000-000000000001", xHandle: null, linkedinUrl: companyPage };
  const grace = { ...makeContact(1), linkedinUrl: companyPage, xHandle: null };
  t.check("the fixtures really are different people", ada.fullName !== grace.fullName && ada.email !== grace.email);

  const keys = identityKeysFor({ linkedinUrl: companyPage, email: null, phone: null, xHandle: null });
  t.check(
    "a company page yields no linkedin_slug identity key",
    !keys.some((k) => k.kind === "linkedin_slug"),
    JSON.stringify(keys)
  );

  const matches = findDuplicateCandidatesIndexed(buildDuplicateIndex([ada]), grace);
  const autoMerge = matches.find((m) => m.confidence >= DUPLICATE_MERGE_CONFIDENCE);
  t.check(
    "two different people sharing a company page URL are not auto-merged",
    !autoMerge,
    autoMerge ? `${autoMerge.reason} @ ${autoMerge.confidence}` : ""
  );

  console.log("\nthe real identifier still matches");
  const sameAda = { ...makeContact(0), linkedinUrl: "https://www.linkedin.com/in/ada-lovelace-0/" };
  const adaProfile = { ...ada, linkedinUrl: "https://linkedin.com/in/Ada-Lovelace-0" };
  const real = findDuplicateCandidatesIndexed(buildDuplicateIndex([adaProfile]), sameAda);
  t.check("the same profile URL is still a confident match", real.some((m) => m.reason === "Same LinkedIn URL" && m.strong));

  t.done("linkedin slug");
});
