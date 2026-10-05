/**
 * The Knowledge page's people index: bounded, narrow, scoped to the caller, and honest about
 * goal fit. Writes to local PGlite. Stop the worktree dev server first.
 * Run: npx tsx scripts/smoke-knowledge-people.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-knowledge-people";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-knowledge-people";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactBriefs, contacts, userGoals } from "../src/db/schema";
import { loadKnowledgePeople } from "../src/lib/knowledge-people";
import { gistOf, GIST_CHARS, KNOWLEDGE_PEOPLE_LIMIT } from "../src/lib/knowledge-people-types";
import { capturedQueries, startQueryCount, stopQueryCount } from "../src/lib/query-counter";

const USER = "smoke-knowledge-people";
const OTHER = "smoke-knowledge-people-other";
function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

// --- pure ---
{
  check("gist is the first sentence", gistOf("You met Priya at the summit. You talked infra.") === "You met Priya at the summit.");
  check("no summary → no gist", gistOf(null) === null && gistOf("   ") === null);
  check("whitespace and newlines collapse", gistOf("One\n\nline   here.") === "One line here.");
  const long = gistOf("word ".repeat(80));
  check(
    "a long sentence is cut at a whole word and marked",
    !!long && long.length <= GIST_CHARS && long.endsWith("\u2026") && long.slice(0, -1).split(" ").every((w) => w === "word"),
    long ?? "null"
  );
  check("a sentence with no full stop still gets a gist", gistOf("Runs infra at Stripe") === "Runs infra at Stripe");
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, [USER, OTHER]));
  await db.delete(userGoals).where(inArray(userGoals.userId, [USER, OTHER]));

  const [gA, gB, gGone] = await db
    .insert(userGoals)
    .values([
      { userId: USER, text: "Get an intro to a Stripe infra lead" },
      { userId: USER, text: "Find a seed investor" },
      { userId: USER, text: "A goal that gets deleted" },
    ])
    .returning();
  await db.insert(userGoals).values({ userId: USER, text: "An archived goal", active: 0 });

  const [priya, sam, , hidden] = await db
    .insert(contacts)
    .values([
      { userId: USER, fullName: "Priya Raman", firstName: "Priya", title: "Infra lead", company: "Stripe", aiSummary: "You met Priya at the summit. She runs infra.", lastInteractionAt: new Date(2026, 8, 20), profileImageUrl: "data:image/png;base64," + "A".repeat(50_000), notes: "N".repeat(5_000) },
      { userId: USER, fullName: "Sam Ortiz", aiSummary: "Sam is a seed investor.", lastInteractionAt: new Date(2026, 8, 25) },
      { userId: USER, fullName: "Lee Park", lastInteractionAt: null },
      { userId: OTHER, fullName: "Someone Else", aiSummary: "Belongs to another account." },
    ])
    .returning();

  await db.insert(contactBriefs).values([
    // Priya: fits two active goals and one goal that is about to be deleted.
    { contactId: priya.id, userId: USER, standing: "s", goalFit: { judged: [gA.id, gB.id, gGone.id], items: [{ goalId: gA.id, why: "Runs infra." }, { goalId: gB.id, why: "Knows angels." }, { goalId: gGone.id, why: "Soon gone." }] } },
    // Sam: judged, nothing fits. Not the same as never judged, and both count zero.
    { contactId: sam.id, userId: USER, standing: "s", goalFit: { judged: [gA.id], items: [] } },
    // A brief belonging to the OTHER account, for a contact of the other account.
    { contactId: hidden.id, userId: OTHER, standing: "s", goalFit: { judged: [], items: [{ goalId: gA.id, why: "Must never leak." }] } },
  ]);

  console.log("\nPeople index");
  startQueryCount();
  let out = await loadKnowledgePeople(USER);
  const count = stopQueryCount();
  const statements = capturedQueries();
  check("two statements: totals and rows", count === 2, `got ${count}`);
  check("the rows read is bounded by LIMIT", statements.some((s) => /from "contacts"/i.test(s) && /\blimit\b/i.test(s)));
  check("notes is never a selected column", statements.every((s) => !/select[^;]*"notes"/i.test(s.replace(/\s+/g, " "))));
  check("only the caller's people", out.rows.length === 3 && out.total === 3, `${out.rows.length}/${out.total}`);
  check("active goals counted, archived ones not", out.goalCount === 3, String(out.goalCount));
  check("most recently touched first, never-touched last", out.rows.map((r) => r.fullName).join(",") === "Sam Ortiz,Priya Raman,Lee Park");

  const byName = Object.fromEntries(out.rows.map((r) => [r.fullName, r]));
  check("gist is the first sentence of the summary", byName["Priya Raman"].gist === "You met Priya at the summit.");
  check("no summary → null gist", byName["Lee Park"].gist === null);
  check("a photo becomes a boolean", byName["Priya Raman"].hasPhoto === true && byName["Sam Ortiz"].hasPhoto === false);
  check("the photo itself never crosses the wire", !JSON.stringify(out).includes("base64"));
  check("fit counts every active goal a brief names", byName["Priya Raman"].fitCount === 3, String(byName["Priya Raman"].fitCount));
  check("judged-with-nothing and never-judged both count zero", byName["Sam Ortiz"].fitCount === 0 && byName["Lee Park"].fitCount === 0);
  check("another account's brief never leaks in", !JSON.stringify(out).includes("Must never leak"));
  check("a row is small", JSON.stringify(out.rows[1]).length < 600, String(JSON.stringify(out.rows[1]).length));

  console.log("\nGoals change without any brief regenerating");
  await db.delete(userGoals).where(eq(userGoals.id, gGone.id));
  out = await loadKnowledgePeople(USER);
  check("a deleted goal stops counting", out.rows.find((r) => r.id === priya.id)!.fitCount === 2);
  check("and the goal total follows", out.goalCount === 2);

  console.log("\nBounded by the limit, not the account");
  const filler = Array.from({ length: KNOWLEDGE_PEOPLE_LIMIT + 25 }, (_, i) => ({
    userId: USER, fullName: `Filler ${i}`, aiSummary: `Filler person ${i}. ` + "x".repeat(2_000),
  }));
  for (let i = 0; i < filler.length; i += 100) await db.insert(contacts).values(filler.slice(i, i + 100));
  out = await loadKnowledgePeople(USER);
  check("rows stop at the limit", out.rows.length === KNOWLEDGE_PEOPLE_LIMIT, String(out.rows.length));
  check("but the total still counts everyone", out.total === filler.length + 3, String(out.total));
  check("and a long summary is cut to a gist", out.rows.every((r) => (r.gist?.length ?? 0) <= GIST_CHARS));

  await db.delete(contacts).where(inArray(contacts.userId, [USER, OTHER]));
  await db.delete(userGoals).where(inArray(userGoals.userId, [USER, OTHER]));
  console.log("\nsmoke-knowledge-people: all checks passed");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
