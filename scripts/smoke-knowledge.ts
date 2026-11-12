/**
 * The Knowledge page's content search: who has this word in their notes, messages or facts.
 *
 * This replaced the Overview feed's search. That one ran in the browser over whichever
 * entries had been shipped, so a note from two years ago produced "No matches" while sitting
 * in the table; the people list's own filter has the same ceiling (the few hundred people it
 * loaded, and only their name, role and summary line). The search here reaches everything,
 * in SQL, so the page cap applies to the RESULTS rather than to what is searchable.
 *
 * Also pinned:
 *   - Legacy `interaction_type` values (`meeting_note`, `coffee`, `sms`) label the same way the
 *     contact page does, because the search reuses its normalizer.
 *   - The match is a literal substring, not a LIKE pattern, so `50%` and `p_ya` mean exactly
 *     that. The old search put the raw text into a LIKE and never escaped it.
 *   - Everything is scoped to the caller.
 *
 * Run: npx tsx scripts/smoke-knowledge.ts
 */
import "./smoke/_env";
Object.assign(process.env, { NODE_ENV: "development" });
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions } from "../src/db/schema";
import { KNOWLEDGE_SEARCH_LIMIT } from "../src/lib/knowledge-people-types";
import { searchKnowledgeContent } from "../src/lib/knowledge-search";

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

const USER = "smoke-knowledge";
const OTHER = "smoke-knowledge-other";
const NEEDLE = "zebracorn";
/** Comfortably past any page the old feed shipped, so "searchable" and "shipped" differ. */
const BULK = 450;

async function main() {
  const db = await getDb();
  const wipe = async () => {
    await db.delete(contacts).where(inArray(contacts.userId, [USER, OTHER]));
  };
  await wipe();

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  const [hassan] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Hassan Ali", company: "Notion" })
    .returning();
  const [priya] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Priya Raman",
      title: "Founder",
      keyFacts: ["fintech founder", "plays tennis"],
      notes: "Revenue grew 50% last year and she wants an intro.",
    })
    .returning();
  // "p_ya" would match "Pxya" if the text were treated as a LIKE pattern.
  await db.insert(contacts).values({ userId: USER, fullName: "Pxya Lee", notes: "Unrelated." });
  const [stranger] = await db
    .insert(contacts)
    .values({ userId: OTHER, fullName: "Someone Else" })
    .returning();

  // The needle sits in the OLDEST interaction, behind a pile of newer ones.
  await db.insert(interactions).values({
    userId: USER,
    contactId: hassan.id,
    interactionType: "note",
    interactionDate: daysAgo(BULK + 100),
    rawNotes: `We talked about ${NEEDLE} and how it changes the query plan.`,
  });
  await db.insert(interactions).values(
    Array.from({ length: BULK }, (_, i) => ({
      userId: USER,
      contactId: hassan.id,
      interactionType: "linkedin_message",
      interactionDate: daysAgo(i + 1),
      rawNotes: `message ${i}`,
    }))
  );
  await db.insert(interactions).values([
    { userId: USER, contactId: hassan.id, interactionType: "meeting_note", interactionDate: daysAgo(2), rawNotes: "legacy meeting note" },
    { userId: USER, contactId: hassan.id, interactionType: "coffee", interactionDate: daysAgo(3), rawNotes: "legacy coffee" },
    { userId: USER, contactId: hassan.id, interactionType: "sms", interactionDate: daysAgo(4), rawNotes: "legacy sms" },
    { userId: OTHER, contactId: stranger.id, interactionType: "note", interactionDate: daysAgo(1), rawNotes: `${NEEDLE} belongs to someone else` },
  ]);

  section("Search reaches past what a page would ship");
  const old = await searchKnowledgeContent(USER, NEEDLE);
  check("finds a note older than 450 newer ones", old.length === 1 && old[0].id === hassan.id, JSON.stringify(old.map((h) => h.fullName)));
  check("labels it as a note", old[0]?.where === "In a note", String(old[0]?.where));
  check("and shows the text around the match", Boolean(old[0]?.snippet?.includes(NEEDLE)));
  check("in a short snippet", (old[0]?.snippet?.length ?? 999) <= 160, String(old[0]?.snippet?.length));
  check("matching ignores case", (await searchKnowledgeContent(USER, NEEDLE.toUpperCase())).length === 1);

  section("Legacy spellings label like the contact page");
  const meeting = await searchKnowledgeContent(USER, "legacy meeting note");
  check("meeting_note is a meeting", meeting[0]?.where === "In a meeting", String(meeting[0]?.where));
  const coffee = await searchKnowledgeContent(USER, "legacy coffee");
  check("coffee is a meeting", coffee[0]?.where === "In a meeting", String(coffee[0]?.where));
  const sms = await searchKnowledgeContent(USER, "legacy sms");
  check("sms is a message", sms[0]?.where === "In a message", String(sms[0]?.where));

  section("Facts, profile notes and names");
  const fact = await searchKnowledgeContent(USER, "fintech");
  check("finds a key fact", fact.length === 1 && fact[0].id === priya.id && fact[0].where === "In their key facts", JSON.stringify(fact));
  check("without the JSON brackets and quotes", !/[\[\]"]/.test(fact[0]?.snippet ?? ""), String(fact[0]?.snippet));
  const note = await searchKnowledgeContent(USER, "wants an intro");
  check("finds profile notes", note[0]?.id === priya.id && note[0]?.where === "In your notes", JSON.stringify(note));
  const byName = await searchKnowledgeContent(USER, "Hassan");
  check("finds a name, with no snippet", byName.length === 1 && byName[0].snippet === null && byName[0].where === null, JSON.stringify(byName));

  section("The text is a literal, not a pattern");
  const percent = await searchKnowledgeContent(USER, "50%");
  check("50% finds the note that says 50%", percent.length === 1 && percent[0].id === priya.id, JSON.stringify(percent.map((h) => h.fullName)));
  const wildcards = await searchKnowledgeContent(USER, "%%%");
  check("%%% matches nothing instead of everything", wildcards.length === 0, `got ${wildcards.length}`);
  const underscore = await searchKnowledgeContent(USER, "p_ya");
  check("p_ya does not match Pxya", underscore.length === 0, JSON.stringify(underscore.map((h) => h.fullName)));
  const backslash = await searchKnowledgeContent(USER, "\\\\\\");
  check("backslashes are inert", backslash.length === 0);

  section("Bounds and scoping");
  check("too short a search is empty", (await searchKnowledgeContent(USER, "ab")).length === 0);
  check("a genuine miss is empty", (await searchKnowledgeContent(USER, "no-such-term-anywhere")).length === 0);
  const mine = await searchKnowledgeContent(USER, NEEDLE);
  check("another account's rows are never returned", mine.every((h) => h.id !== stranger.id));
  const theirs = await searchKnowledgeContent(OTHER, NEEDLE);
  check("and they find only their own", theirs.length === 1 && theirs[0].id === stranger.id);

  await db.insert(contacts).values(
    Array.from({ length: KNOWLEDGE_SEARCH_LIMIT + 20 }, (_, i) => ({
      userId: USER,
      fullName: `Bulk Person ${i}`,
      notes: "mentions quokkaterm once",
    }))
  );
  const capped = await searchKnowledgeContent(USER, "quokkaterm");
  check("the result is capped", capped.length === KNOWLEDGE_SEARCH_LIMIT, `got ${capped.length}`);

  await db.delete(interactions).where(eq(interactions.userId, USER));
  await wipe();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll knowledge search checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
