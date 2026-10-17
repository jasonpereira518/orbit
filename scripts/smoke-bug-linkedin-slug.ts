/**
 * KNOWN BUG — documented, not fixed.
 *
 * Symptom: two DIFFERENT people whose LinkedIn field holds the same non-profile LinkedIn URL
 * (a company page, a school page, a bare `linkedin.com/in/`) are treated as the same person
 * and merged automatically.
 *
 * Why: `linkedinSlug()` (src/lib/duplicates.ts:83) falls back to the whole normalised URL
 * when there is no `/in/<slug>` to extract. That fallback is non-empty, so
 * `identityKeysFor` emits a `linkedin_slug` identity for it and
 * `findDuplicateCandidatesIndexed` reports "Same LinkedIn URL" at 0.98 — above
 * DUPLICATE_MERGE_CONFIDENCE (0.85), i.e. an automatic merge. The function's own doc comment
 * says it MUST stay equal to the `linkedin_slug` generated column, and that column
 * (LINKEDIN_SLUG_EXPRESSION in src/db/index.ts) returns NULL for these URLs, so the two
 * spellings of the rule disagree.
 *
 * Trigger: a CSV import or a hand-typed contact where someone pastes their employer's
 * company page into the LinkedIn field (`isLinkedInProfileUrl` accepts any linkedin.com
 * path, src/lib/contact-input.ts:66) — then every colleague given the same URL collapses into
 * one contact.
 *
 * When fixed (`linkedinSlug` returns "" whenever the column would be NULL) every check here
 * passes, the script exits 0, and it should move to the pglite tier as an ordinary smoke.
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
  console.log("\nprofile URLs: the function and the column agree (correct today)");
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
    t.knownBug(`BUG: linkedinSlug(${url}) disagrees with the generated column`, fn === col, `function "${fn}", column "${col}"`);
  }

  console.log("\ntwo different people sharing their employer's company page");
  const companyPage = "https://www.linkedin.com/company/acme-analytics";
  const ada = { ...makeContact(0), id: "00000000-0000-4000-8000-000000000001", xHandle: null, linkedinUrl: companyPage };
  const grace = { ...makeContact(1), linkedinUrl: companyPage, xHandle: null };
  t.check("the fixtures really are different people", ada.fullName !== grace.fullName && ada.email !== grace.email);

  const keys = identityKeysFor({ linkedinUrl: companyPage, email: null, phone: null, xHandle: null });
  t.knownBug(
    "BUG: a company page yields a linkedin_slug identity key",
    !keys.some((k) => k.kind === "linkedin_slug"),
    JSON.stringify(keys)
  );

  const matches = findDuplicateCandidatesIndexed(buildDuplicateIndex([ada]), grace);
  const autoMerge = matches.find((m) => m.confidence >= DUPLICATE_MERGE_CONFIDENCE);
  t.knownBug(
    "BUG: two different people are auto-merged because they share a company page URL",
    !autoMerge,
    autoMerge ? `${autoMerge.reason} @ ${autoMerge.confidence}` : ""
  );

  console.log("\nthe real identifier still matches (must keep working after a fix)");
  const sameAda = { ...makeContact(0), linkedinUrl: "https://www.linkedin.com/in/ada-lovelace-0/" };
  const adaProfile = { ...ada, linkedinUrl: "https://linkedin.com/in/Ada-Lovelace-0" };
  const real = findDuplicateCandidatesIndexed(buildDuplicateIndex([adaProfile]), sameAda);
  t.check("the same profile URL is still a confident match", real.some((m) => m.reason === "Same LinkedIn URL" && m.strong));

  t.done("linkedin slug bug");
});
