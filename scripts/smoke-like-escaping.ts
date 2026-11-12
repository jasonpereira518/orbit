/**
 * Audit L-04: a `%` or `_` typed into a search box is a character to find, not a wildcard.
 *
 * Three searches built `%${q}%` (or `${q}%`) from the raw query: the contacts list and picker
 * (`contactSearchCondition`), the knowledge page, and the shared recruiter pool. A bare `%`
 * matched the whole table and `%a%b%c%…` was a cheap CPU burn. The first and last now go
 * through `escapeLike`, like the name-tier ranking beside them always did; the knowledge
 * search is a literal `strpos` match, so it has no pattern to escape.
 *
 * Run: npx tsx scripts/smoke-like-escaping.ts
 */
import "./smoke/_env";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, recruiters, userRecruiterLinks } from "../src/db/schema";
import { contactSearchCondition, escapeLike } from "../src/lib/contact-search-rank";
import { searchKnowledgeContent } from "../src/lib/knowledge-search";
import { searchCanonicalRecruiters } from "../src/lib/recruiters";
import { run } from "./smoke/_env";

const U = "smoke-like-escaping-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, U));

  check("escapeLike escapes %, _ and the escape character itself", escapeLike("50%_a\\b") === "50\\%\\_a\\\\b");

  console.log("Contacts search...");
  await db.insert(contacts).values([
    { userId: U, fullName: "50% Club", notes: "Saved 50% on rent with Ada" },
    { userId: U, fullName: "500 Startups" },
    { userId: U, fullName: "Ada_Lovelace" },
    { userId: U, fullName: "AdaXLovelace" },
    { userId: U, fullName: "Zed Shaw", notes: "Nothing to see here" },
  ]);
  const names = async (q: string) =>
    (
      await db
        .select({ fullName: contacts.fullName })
        .from(contacts)
        .where(and(eq(contacts.userId, U), contactSearchCondition(q)))
    )
      .map((r) => r.fullName)
      .sort();
  const all = await names("%");
  check('"%" no longer matches every contact', all.length < 5, JSON.stringify(all));
  check('"%" matches nobody whose name does not start with it', !all.includes("Zed Shaw") && !all.includes("500 Startups"), JSON.stringify(all));
  const fifty = await names("50%");
  check('"50%" finds the literal "50% Club", not "500 Startups"', fifty.includes("50% Club") && !fifty.includes("500 Startups"), JSON.stringify(fifty));
  const underscore = await names("Ada_");
  check('"Ada_" finds "Ada_Lovelace" and not "AdaXLovelace"', underscore.includes("Ada_Lovelace") && !underscore.includes("AdaXLovelace"), JSON.stringify(underscore));

  console.log("\nKnowledge search...");
  // A literal `strpos` match, not a LIKE pattern, so there is nothing to escape (and a query
  // under three characters is not searched at all, so a bare "%" is never the whole table).
  const kb = async (q: string) => (await searchKnowledgeContent(U, q)).map((h) => h.fullName).sort();
  const kbBare = await kb("%");
  check('a bare "%" is below the search minimum and finds nothing', kbBare.length === 0, JSON.stringify(kbBare));
  const kbPercent = await kb("50%");
  check(
    '"50%" finds the literal "50% Club", not "500 Startups"',
    kbPercent.includes("50% Club") && !kbPercent.includes("500 Startups"),
    JSON.stringify(kbPercent)
  );
  const kbWild = await kb("%%%");
  check('"%%%" is not a wildcard: it finds nobody', kbWild.length === 0, JSON.stringify(kbWild));
  const kbUnderscore = await kb("Ada_");
  check(
    '"Ada_" finds "Ada_Lovelace" and not "AdaXLovelace"',
    kbUnderscore.includes("Ada_Lovelace") && !kbUnderscore.includes("AdaXLovelace"),
    JSON.stringify(kbUnderscore)
  );

  console.log("\nShared recruiter search...");
  const inserted = await db
    .insert(recruiters)
    .values([
      { fullName: "Pat 100% Placement", nameNormalized: "pat 100% placement", firm: "Acme" },
      { fullName: "Pat Plain", nameNormalized: "pat plain", firm: "Globex" },
    ])
    .returning();
  const ids = inserted.map((r) => r.id);
  await db.insert(userRecruiterLinks).values(ids.map((recruiterId) => ({ userId: U, recruiterId })));
  const search = async (q: string) =>
    (await searchCanonicalRecruiters({ q, viewerUserId: U, viewerIsSharing: false })).map((r) => r.fullName).sort();
  const recPercent = await search("%");
  check('"%" finds only the recruiter with a literal percent sign', JSON.stringify(recPercent) === JSON.stringify(["Pat 100% Placement"]), JSON.stringify(recPercent));
  const recUnderscore = await search("_");
  check('"_" matches no one (no underscores in these names)', recUnderscore.length === 0, JSON.stringify(recUnderscore));
  const recPlain = await search("pat");
  check("an ordinary search still finds both", recPlain.length === 2, JSON.stringify(recPlain));

  await db.delete(userRecruiterLinks).where(eq(userRecruiterLinks.userId, U));
  await db.delete(recruiters).where(inArray(recruiters.id, ids));
  await db.delete(contacts).where(eq(contacts.userId, U));
});
