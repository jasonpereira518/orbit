/**
 * Proves the SQL in `dashboard-aggregates.ts` answers what the JavaScript it replaces did.
 *
 * `getDashboardData` loaded every contact and counted them in JS. Moving those counts into
 * Postgres is only safe if the two agree — a translation that drifts is worse than none,
 * because the page keeps rendering with different numbers and nothing fails. So this holds
 * the originals next to the replacements over one fixture built to hit every edge the
 * expressions have: null and zero scores, out-of-range scores, dormancy exactly on the
 * boundary, follow-ups either side of now, blank and whitespace-only companies.
 *
 * Runs against the local PGlite database. Run: npx tsx scripts/smoke-dashboard-aggregates.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactTags, contacts, tags } from "../src/db/schema";
import { isCometContact } from "../src/lib/comet";
import {
  getDashboardCounts,
  getDashboardVocabularies,
} from "../src/lib/dashboard-aggregates";
import { startQueryCount, stopQueryCount } from "../src/lib/query-counter";

const USER = "smoke-dashboard-aggregates-user";
const DAY = 86400000;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const ago = (days: number) => new Date(Date.now() - days * DAY);
const ahead = (days: number) => new Date(Date.now() + days * DAY);

/** The originals, copied verbatim from getDashboardData so the comparison is honest. */
function scoreCountsInJs(rows: Array<{ orbitScore: number | null; relationshipScore: number | null }>) {
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const c of rows) {
    const s = Math.min(5, Math.max(1, (c.orbitScore ?? c.relationshipScore) || 2));
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

async function seed() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const rows = [
    // --- score edges. The `(orbit ?? relationship) || 2` chain is the subtle one.
    { fullName: "Orbit five", orbitScore: 5, relationshipScore: 1 },
    { fullName: "Orbit null falls to relationship", relationshipScore: 4 },
    // orbit_score 0 is NOT relationship_score: `??` keeps the 0, then `|| 2` makes it 2.
    // A single COALESCE(orbit, relationship, 2) would score this 1 after the clamp.
    { fullName: "Orbit zero becomes two", orbitScore: 0, relationshipScore: 5 },
    // `relationship_score` is NOT NULL DEFAULT 2 in the DDL, so "both null" is unreachable
    // and is not tested. A zeroed relationship score with no orbit score is reachable, and
    // takes the same `|| 2` branch.
    { fullName: "Relationship zero becomes two", relationshipScore: 0 },
    // relationship_score omitted, not nulled: passing null explicitly overrides the
    // column's NOT NULL DEFAULT 2 and the insert is rejected.
    { fullName: "Above range clamps to five", orbitScore: 9 },
    { fullName: "Below range clamps to one", orbitScore: 1 },

    // --- dormancy. isCometContact floors whole days and needs a known last interaction.
    { fullName: "Dormant well past a year", lastInteractionAt: ago(500) },
    { fullName: "Dormant exactly at the boundary", lastInteractionAt: ago(365) },
    { fullName: "Not dormant, just inside", lastInteractionAt: ago(364) },
    { fullName: "Never interacted is not dormant", lastInteractionAt: null },

    // --- follow-ups either side of now.
    { fullName: "Overdue follow-up", nextFollowUpAt: ago(3) },
    { fullName: "Future follow-up", nextFollowUpAt: ahead(3) },
    { fullName: "No follow-up", nextFollowUpAt: null },

    // --- vocabularies, including the blanks the JS `.trim()` / `.filter(Boolean)` dropped.
    { fullName: "At Acme", company: "Acme", school: "Redbrick" },
    { fullName: "Also at Acme", company: "Acme", school: null },
    { fullName: "Padded company", company: "  Acme  ", school: "  Redbrick  " },
    { fullName: "Blank company", company: "", school: "" },
    { fullName: "Whitespace company", company: "   ", school: "   " },
    { fullName: "At Zenith", company: "Zenith", school: "Ivy" },
  ];

  for (const r of rows) {
    await db.insert(contacts).values({ userId: USER, ...r });
  }

  // One tag on one contact, and a tag on nobody — the second must not reach the filter list.
  const [used] = await db.insert(tags).values({ userId: USER, name: "mentor" }).returning();
  await db.insert(tags).values({ userId: USER, name: "orphan-tag" });
  const [first] = await db.select().from(contacts).where(eq(contacts.userId, USER)).limit(1);
  await db.insert(contactTags).values({ contactId: first.id, tagId: used.id });
}

async function main() {
  await seed();
  const db = await getDb();
  const all = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });

  console.log("Counts (SQL vs the JavaScript it replaces)…");
  const counts = await getDashboardCounts(USER);

  check("totalContacts matches", counts.totalContacts === all.length,
    `sql ${counts.totalContacts} vs js ${all.length}`);

  const jsDormant = all.filter((c) => isCometContact(c.lastInteractionAt)).length;
  check("dormantCount matches isCometContact", counts.dormantCount === jsDormant,
    `sql ${counts.dormantCount} vs js ${jsDormant}`);
  check("…and the boundary contact is counted", jsDormant === 2, `${jsDormant}`);

  const now = Date.now();
  const jsOverdue = all.filter(
    (c) => c.nextFollowUpAt && new Date(c.nextFollowUpAt).getTime() < now
  ).length;
  check("overdueCount matches", counts.overdueCount === jsOverdue,
    `sql ${counts.overdueCount} vs js ${jsOverdue}`);

  const jsScores = scoreCountsInJs(all);
  const sqlScores = counts.scoreCounts as unknown as Record<number, number>;
  const scoresAgree = [1, 2, 3, 4, 5].every((s) => sqlScores[s] === jsScores[s]);
  check("the score histogram matches bucket for bucket", scoresAgree,
    `sql ${JSON.stringify(sqlScores)} vs js ${JSON.stringify(jsScores)}`);
  // Named explicitly: this is the bucket a single COALESCE would get wrong.
  check("a zeroed orbit score lands in bucket 2, not bucket 1", sqlScores[2] === jsScores[2] && jsScores[2] >= 2,
    `bucket 2 = ${sqlScores[2]}`);

  console.log("\nVocabularies…");
  const vocab = await getDashboardVocabularies(USER);
  const jsCompanies = [...new Set(all.map((c) => (c.company || "").trim()).filter(Boolean))].sort();
  const jsSchools = [...new Set(all.map((c) => (c.school || "").trim()).filter(Boolean))].sort();

  check("companies match the trimmed, de-duplicated JS set",
    JSON.stringify([...vocab.companies].sort()) === JSON.stringify(jsCompanies),
    `sql ${JSON.stringify(vocab.companies)} vs js ${JSON.stringify(jsCompanies)}`);
  check("a padded duplicate collapses into one entry", vocab.companies.filter((c) => c === "Acme").length === 1,
    JSON.stringify(vocab.companies));
  check("blank and whitespace-only companies are dropped",
    !vocab.companies.some((c) => c.trim() === ""), JSON.stringify(vocab.companies));
  check("schools match", JSON.stringify([...vocab.schools].sort()) === JSON.stringify(jsSchools),
    `sql ${JSON.stringify(vocab.schools)} vs js ${JSON.stringify(jsSchools)}`);

  check("tags list the one actually applied", vocab.tags.includes("mentor"));
  check("a tag on nobody never reaches the filter list", !vocab.tags.includes("orphan-tag"),
    JSON.stringify(vocab.tags));

  console.log("\nAn empty account…");
  const empty = await getDashboardCounts("smoke-dashboard-aggregates-nobody");
  check("counts are zero, not null", empty.totalContacts === 0 && empty.dormantCount === 0 &&
    empty.overdueCount === 0 && empty.scoreCounts[3] === 0, JSON.stringify(empty));
  const emptyVocab = await getDashboardVocabularies("smoke-dashboard-aggregates-nobody");
  check("vocabularies are empty arrays",
    emptyVocab.companies.length === 0 && emptyVocab.schools.length === 0 && emptyVocab.tags.length === 0);

  // The point of moving these into SQL is round trips, so the round trips are the budget.
  // On neon-http every statement is a separate HTTPS request.
  console.log("\nStatement cost…");
  startQueryCount();
  await getDashboardCounts(USER);
  const countStatements = stopQueryCount();
  check("all four counts come back in one statement", countStatements === 1, `got ${countStatements}`);

  startQueryCount();
  await getDashboardVocabularies(USER);
  const vocabStatements = stopQueryCount();
  check("companies and schools share a statement, tags take one more",
    vocabStatements === 2, `got ${vocabStatements}`);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll dashboard-aggregate checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
