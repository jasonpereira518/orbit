/**
 * One person's history on the Knowledge page: what `loadKnowledgeTimeline` returns.
 *
 * Pinned: it is scoped to the caller (another account's contact id yields nothing), newest
 * first, bucketed the way the contact page labels (legacy `meeting_note`, `coffee`, `sms`),
 * bounded (a long history is cut with a flag, and text is cut in SQL), and honest about who
 * sent a message (`direction` stays NULL when the import never recorded it).
 *
 * Run: npx tsx scripts/smoke-knowledge-timeline.ts
 */
import "./smoke/_env";
Object.assign(process.env, { NODE_ENV: "development" });
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;

import { inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions } from "../src/db/schema";
import { loadKnowledgeTimeline } from "../src/lib/knowledge-timeline";
import {
  KNOWLEDGE_TIMELINE_LIMIT,
  KNOWLEDGE_TIMELINE_TEXT_CHARS,
} from "../src/lib/knowledge-timeline-types";

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

const USER = "smoke-knowledge-timeline";
const OTHER = "smoke-knowledge-timeline-other";

async function main() {
  const db = await getDb();
  const wipe = async () => {
    await db.delete(contacts).where(inArray(contacts.userId, [USER, OTHER]));
  };
  await wipe();

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  const [ada] = await db.insert(contacts).values({ userId: USER, fullName: "Ada Lovelace" }).returning();
  const [empty] = await db.insert(contacts).values({ userId: USER, fullName: "Nobody Yet" }).returning();

  await db.insert(interactions).values([
    { userId: USER, contactId: ada.id, interactionType: "linkedin_message", interactionDate: daysAgo(1), rawNotes: "Happy to intro you", direction: "in" },
    { userId: USER, contactId: ada.id, interactionType: "linkedin_message", interactionDate: daysAgo(2), rawNotes: "Sent an old message", direction: null },
    { userId: USER, contactId: ada.id, interactionType: "message", interactionDate: daysAgo(3), rawNotes: "You wrote this", direction: "out" },
    { userId: USER, contactId: ada.id, interactionType: "meeting_note", interactionDate: daysAgo(5), rawNotes: "legacy meeting" },
    { userId: USER, contactId: ada.id, interactionType: "coffee", interactionDate: daysAgo(6), rawNotes: "legacy coffee" },
    { userId: USER, contactId: ada.id, interactionType: "sms", interactionDate: daysAgo(7), rawNotes: "legacy sms" },
    { userId: USER, contactId: ada.id, interactionType: "note", interactionDate: daysAgo(8), rawNotes: "raw note", aiSummary: "The summary wins" },
    { userId: USER, contactId: ada.id, interactionType: "note", interactionDate: daysAgo(9), rawNotes: "x".repeat(KNOWLEDGE_TIMELINE_TEXT_CHARS * 4) },
  ]);

  section("Order, kinds and text");
  const t = await loadKnowledgeTimeline(USER, ada.id);
  check("every interaction comes back", t.items.length === 8, `got ${t.items.length}`);
  check("not truncated", t.truncated === false);
  const dates = t.items.map((i) => Date.parse(i.date));
  check("newest first", dates.every((d, i) => i === 0 || dates[i - 1] >= d));
  const kindOf = (text: string) => t.items.find((i) => i.text === text)?.kind;
  check("linkedin_message is a message", kindOf("Happy to intro you") === "message");
  check("legacy sms is a message", kindOf("legacy sms") === "message");
  check("legacy meeting_note is a meeting", kindOf("legacy meeting") === "meeting");
  check("legacy coffee is a meeting", kindOf("legacy coffee") === "meeting");
  check("a plain note is a note", t.items.find((i) => i.text === "The summary wins")?.kind === "note");
  check("the AI summary wins over the raw note", !t.items.some((i) => i.text === "raw note"));
  check(
    "long text is cut in SQL",
    t.items.every((i) => (i.text?.length ?? 0) <= KNOWLEDGE_TIMELINE_TEXT_CHARS),
    `${Math.max(...t.items.map((i) => i.text?.length ?? 0))} chars`
  );

  section("Direction is only what was recorded");
  check("'in' is kept", t.items.find((i) => i.text === "Happy to intro you")?.direction === "in");
  check("'out' is kept", t.items.find((i) => i.text === "You wrote this")?.direction === "out");
  check("an unknown sender stays null", t.items.find((i) => i.text === "Sent an old message")?.direction === null);

  section("Scoping and edges");
  check("another account sees nothing of this contact", (await loadKnowledgeTimeline(OTHER, ada.id)).items.length === 0);
  const none = await loadKnowledgeTimeline(USER, empty.id);
  check("a person with no history is empty, not an error", none.items.length === 0 && none.truncated === false);
  check(
    "an unknown contact id is empty",
    (await loadKnowledgeTimeline(USER, "00000000-0000-4000-8000-000000000000")).items.length === 0
  );

  section("A long history is cut, and says so");
  await db.insert(interactions).values(
    Array.from({ length: KNOWLEDGE_TIMELINE_LIMIT + 10 }, (_, i) => ({
      userId: USER,
      contactId: empty.id,
      interactionType: "note",
      interactionDate: daysAgo(i + 1),
      rawNotes: `note ${i}`,
    }))
  );
  const long = await loadKnowledgeTimeline(USER, empty.id);
  check("capped at the limit", long.items.length === KNOWLEDGE_TIMELINE_LIMIT, `got ${long.items.length}`);
  check("flagged as truncated", long.truncated === true);
  check("and the newest are the ones kept", long.items[0].text === "note 0", String(long.items[0].text));

  await db.delete(interactions).where(inArray(interactions.userId, [USER, OTHER]));
  await wipe();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll knowledge timeline checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
