/**
 * Noticing that a contact moved.
 *
 * A job change is the easiest moment to reach out — congratulations are welcome and the
 * window is narrow — and Orbit could not see one. `contacts.company` and `.title` are
 * overwritten in place by the Apollo/LinkedIn refresh, by imports and by ordinary edits, so
 * the previous employer was gone and "just joined Stripe" was indistinguishable from "has
 * been at Stripe for six years".
 *
 * The rule this file exists to protect: a transition FROM nothing is not a job change. A
 * network of imported LinkedIn connections has thousands of contacts with no company on
 * file; the first enrichment pass fills them in, and if that counted as moving, one
 * afternoon would produce hundreds of congratulations for jobs people have held for years —
 * every one wrong, in a queue the user would then stop reading. The same goes in reverse:
 * enrichment returning no company means it did not find one, never that someone is out of
 * work.
 *
 * Run: npx tsx scripts/smoke-job-changes.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-job-changes";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-job-changes";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { aiSuggestions, contactJobChanges, contacts, userSettings } from "../src/db/schema";
import { describeJobChange, detectJobChange } from "../src/lib/job-changes";
import { createContactForUser, updateContactForUser } from "../src/lib/contact-writes";
import { refreshOutreachSuggestions } from "../src/lib/reminders";
import { ensureUserSettings } from "../src/lib/user-settings";

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

const USER = "smoke-job-changes-user";
const OPTS = {
  skipRevalidate: true,
  skipEmbedding: true,
  skipSummary: true,
  skipCloseness: true,
} as const;

function pureChecks() {
  section("A real move is a move");

  const moved = detectJobChange(
    { company: "Figma", title: "Designer" },
    { company: "Stripe", title: "Design Lead" }
  );
  check("employer change is detected", moved?.changedCompany === true);
  check("and carries where they came from", moved?.previousCompany === "Figma");
  check(
    "a promotion at the same employer counts too",
    detectJobChange({ company: "Stripe", title: "Engineer" }, { company: "Stripe", title: "Staff Engineer" }) !== null
  );
  check(
    "but is not reported as an employer change",
    detectJobChange({ company: "Stripe", title: "Engineer" }, { company: "Stripe", title: "Staff Engineer" })
      ?.changedCompany === false,
    "telling someone they 'joined' a company they have worked at for years is worse than saying nothing"
  );

  section("Learning is not moving");

  check(
    "null to a company is not a move",
    detectJobChange({ company: null, title: null }, { company: "Stripe", title: "Engineer" }) === null,
    "this is the one that would congratulate a whole imported network in an afternoon"
  );
  check(
    "empty string counts as null",
    detectJobChange({ company: "   ", title: "" }, { company: "Stripe", title: "Engineer" }) === null
  );
  check(
    "a company to null is not a move either",
    detectJobChange({ company: "Stripe", title: "Engineer" }, { company: null, title: null }) === null,
    "enrichment finding nothing does not mean the person is unemployed"
  );

  section("The same job written differently is the same job");

  check(
    "company punctuation, case and legal suffix",
    detectJobChange({ company: "Stripe" }, { company: "stripe, inc." }) === null,
    "two sources spelling the same employer differently must not read as a move"
  );
  check(
    "a suffix-only company is not stripped to nothing",
    detectJobChange({ company: "Inc" }, { company: "Stripe" }) !== null,
    "stripping every token would make every one-word company equal to every other"
  );
  check(
    "a genuinely different employer still counts",
    detectJobChange({ company: "Stripe Inc" }, { company: "Square Inc" }) !== null
  );
  check(
    "title case and spacing",
    detectJobChange({ title: "Staff  Engineer" }, { title: "staff engineer" }) === null
  );
  check(
    "a field the patch omits is left alone",
    detectJobChange({ company: "Stripe", title: "Engineer" }, { title: "Engineer" }) === null,
    "undefined means 'not in this patch', which must not read as 'cleared'"
  );

  section("What the queue says");

  check(
    "a move names both ends",
    describeJobChange({
      previousCompany: "Figma",
      newCompany: "Stripe",
      previousTitle: "Designer",
      newTitle: "Design Lead",
    }) === "Moved to Design Lead at Stripe — was at Figma"
  );
  check(
    "a promotion reads as one",
    describeJobChange({
      previousCompany: "Stripe",
      newCompany: "Stripe",
      previousTitle: "Engineer",
      newTitle: "Staff Engineer",
    }) === "New title at Stripe: Engineer → Staff Engineer",
    "never 'Moved to' for somebody who did not move"
  );
}

async function dbChecks() {
  const db = await getDb();
  await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  section("The write path records it");

  const mover = await createContactForUser(
    USER,
    { fullName: "Mover Mia", company: "Figma", title: "Designer" },
    OPTS
  );
  const learner = await createContactForUser(USER, { fullName: "Blank Ben" }, OPTS);

  await updateContactForUser(USER, mover!.id, { company: "Stripe", title: "Design Lead" }, OPTS);
  // The enrichment-fills-in-a-blank case, which must record nothing.
  await updateContactForUser(USER, learner!.id, { company: "Notion", title: "Engineer" }, OPTS);

  const rows = await db.query.contactJobChanges.findMany({
    where: eq(contactJobChanges.userId, USER),
  });
  check("the move is recorded", rows.some((r) => r.contactId === mover!.id));
  check(
    "learning a first employer is not",
    !rows.some((r) => r.contactId === learner!.id),
    "a first enrichment pass over an imported network must stay silent"
  );
  check("exactly one row", rows.length === 1, `got ${rows.length}`);
  check("with the old employer kept", rows[0]?.previousCompany === "Figma");

  section("It reaches the outreach queue");

  await refreshOutreachSuggestions(USER);
  const suggestions = await db.query.aiSuggestions.findMany({
    where: eq(aiSuggestions.userId, USER),
  });
  const forMover = suggestions.find((s) =>
    (s.relatedContactIds as string[] | null)?.includes(mover!.id)
  );
  check("a suggestion is raised", forMover?.suggestionType === "job_change", `got ${forMover?.suggestionType}`);
  check("titled as a congratulation", (forMover?.title ?? "").startsWith("Congratulate"));
  check(
    "describing the move",
    (forMover?.description ?? "").includes("Stripe") && (forMover?.description ?? "").includes("Figma"),
    `got ${JSON.stringify(forMover?.description)}`
  );
  check(
    "and nothing is raised for the contact who merely got enriched",
    !suggestions.some(
      (s) =>
        (s.relatedContactIds as string[] | null)?.includes(learner!.id) &&
        s.suggestionType === "job_change"
    )
  );

  section("One suggestion per contact, however many hops");

  await updateContactForUser(USER, mover!.id, { title: "Head of Design" }, OPTS);
  await refreshOutreachSuggestions(USER);
  const after = await db.query.aiSuggestions.findMany({
    where: eq(aiSuggestions.userId, USER),
  });
  const moverRows = after.filter((s) =>
    (s.relatedContactIds as string[] | null)?.includes(mover!.id)
  );
  check("still one row for them", moverRows.length === 1, `got ${moverRows.length}`);
  check(
    "naming where they ended up",
    (moverRows[0]?.description ?? "").includes("Head of Design"),
    `got ${JSON.stringify(moverRows[0]?.description)}`
  );

  section("A stale move drops out");

  await db
    .update(contactJobChanges)
    .set({ detectedAt: new Date(Date.now() - 120 * 86_400_000) })
    .where(eq(contactJobChanges.userId, USER));
  await refreshOutreachSuggestions(USER);
  const stale = await db.query.aiSuggestions.findMany({
    where: eq(aiSuggestions.userId, USER),
  });
  check(
    "four months on, it is no longer news",
    !stale.some((s) => s.suggestionType === "job_change"),
    "a congratulation that late reads as an afterthought"
  );

  await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

async function main() {
  pureChecks();
  await dbChecks();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll job-change checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
