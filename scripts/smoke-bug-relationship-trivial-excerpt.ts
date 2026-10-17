/**
 * KNOWN BUG — documented, not fixed.
 *
 * Symptom: the relationship engine's hallucination guard accepts a one- or two-character
 * "excerpt". A model answer that invents a fact ("Is going through a divorce") or a
 * commitment and cites the excerpt "ok" is applied as if quoted — because "ok" occurs in
 * almost any thread, including inside "Looking forward to it". The invented fact is written to
 * the contact's key facts with no human review.
 *
 * Why: `locateExcerpt` (src/lib/relationship-engine/validate.ts:19-27) only requires the
 * normalised excerpt to be a non-empty SUBSTRING of one message. There is no minimum length,
 * no word-boundary check, and no requirement that the excerpt relate to the claim it backs.
 * `validateDigest` keeps every fact / commitment / implied step / closure whose excerpt is
 * located (:34 onward), and `processDigestAnswer` (src/lib/relationship-engine/runner.ts:129)
 * applies the result straight to `contacts.key_facts`, action items and reminders. The guard
 * is the module's whole defence ("validate.ts drops anything whose excerpt is not in the
 * window") and the prompt treats the messages as untrusted, so a prompt-injected or confused
 * model needs only to quote two letters.
 *
 * Trigger path: any relationship pass (`runRelationshipPass` → `extractRelationshipDigest`
 * → `processDigestAnswer`) over an imported LinkedIn / email thread, where the model returns a
 * short excerpt. Sender-controlled message text can also instruct the model to do so.
 *
 * Severity: medium — fabricated facts and to-dos are silently written to a user's contact
 * record; no cross-account reach.
 *
 * Fix: require a meaningful excerpt (e.g. at least a few words / ~12 characters, matched on
 * word boundaries) in `locateExcerpt`, as a floor shared by every caller. This script then
 * exits 0 and should be promoted to the pglite tier.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-bug-relationship-trivial-excerpt.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { actionItems, contacts, relationshipRuns } from "../src/db/schema";
import { parseDigestAnswer } from "../src/lib/relationship-engine/extract";
import { processDigestAnswer } from "../src/lib/relationship-engine/runner";
import { locateExcerpt, validateDigest } from "../src/lib/relationship-engine/validate";
import type { MessageWindow, WindowMessage } from "../src/lib/relationship-engine/types";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, insertInteraction, purgeUsers } from "./smoke/factories";

const t = checker();
const USER = fakeUserId("rel-trivial-excerpt");
const FABRICATED_FACT = "Is going through a divorce";
const FABRICATED_TASK = "Wire Ada $5,000 for the deposit";

function windowOf(contactId: string, messages: WindowMessage[]): MessageWindow {
  const last = messages[messages.length - 1];
  return {
    contactId,
    messages,
    text: messages.map((m) => `[${m.at.toISOString().slice(0, 10)} ${m.speaker}] ${m.text}`).join("\n"),
    last: { at: last.at, interactionId: last.interactionId },
    truncatedBefore: null,
    sources: ["linkedin"],
  };
}

const answerWith = (excerpt: string) =>
  parseDigestAnswer(
    JSON.stringify({
      what_they_do: null,
      working_on: null,
      job_change: null,
      summary: "Caught up about the analytics project.",
      topics: ["analytics"],
      facts: [{ text: FABRICATED_FACT, excerpt }],
      commitments: [{ title: FABRICATED_TASK, owed_by: "me", raw_date_phrase: null, date: "", date_kind: null, year_stated: false, kind: "task", confidence: 0.9, excerpt }],
      implied: [],
      closed: [],
    })
  );

run(async () => {
  const db = await getDb();
  await purgeUsers(db, [USER]);

  try {
    const contact = await insertContact(db, USER, 0);
    const i1 = await insertInteraction(db, USER, contact.id, {
      interactionType: "linkedin_message",
      direction: "in",
      rawNotes: "Looking forward to catching up about the analytics project next month.",
      interactionDate: new Date("2026-09-01T15:00:00Z"),
    });
    const i2 = await insertInteraction(db, USER, contact.id, {
      interactionType: "linkedin_message",
      direction: "out",
      rawNotes: "Sounds good, talk then.",
      interactionDate: new Date("2026-09-01T16:00:00Z"),
    });
    const window = windowOf(contact.id, [
      { interactionId: i1.id, at: i1.interactionDate, direction: "in", speaker: "Ada", text: i1.rawNotes ?? "" },
      { interactionId: i2.id, at: i2.interactionDate, direction: "out", speaker: "Me", text: i2.rawNotes ?? "" },
    ]);

    console.log("\nThe guard itself...");
    t.check("an invented excerpt is rejected", locateExcerpt(window, "she is getting divorced") === null);
    const honest = validateDigest(answerWith("talk then about the divorce"), window, new Set());
    t.check("a fabricated fact with an unquotable excerpt is dropped", honest.facts.length === 0 && honest.undated.length === 0);
    t.check("a real quote is located in its message", locateExcerpt(window, "catching up about the analytics project")?.interactionId === i1.id);

    const located = locateExcerpt(window, "ok");
    t.knownBug(
      "BUG: locateExcerpt accepts a 2-character excerpt (\"ok\" matches inside \"Looking\")",
      located === null,
      located ? `matched message: ${JSON.stringify(located.text)}` : ""
    );
    const v = validateDigest(answerWith("ok"), window, new Set());
    t.knownBug(
      "BUG: validateDigest keeps a fabricated fact whose excerpt is \"ok\"",
      !v.facts.includes(FABRICATED_FACT),
      `facts=${JSON.stringify(v.facts)}`
    );

    console.log("\n...and what it lets through, end to end (processDigestAnswer)...");
    const [runRow] = await db.insert(relationshipRuns).values({ userId: USER, status: "running" }).returning();
    await processDigestAnswer(USER, runRow.id, contact.id, window, answerWith("ok"), new Date("2026-09-02T09:00:00Z"));
    const [after] = await db.select({ keyFacts: contacts.keyFacts }).from(contacts).where(eq(contacts.id, contact.id));
    t.knownBug(
      "BUG: a fabricated fact backed only by the excerpt \"ok\" is written to the contact's key facts",
      !(after?.keyFacts ?? []).includes(FABRICATED_FACT),
      `key_facts=${JSON.stringify(after?.keyFacts)}`
    );
    const items = await db.select().from(actionItems).where(and(eq(actionItems.userId, USER), eq(actionItems.contactId, contact.id)));
    t.knownBug(
      "BUG: a fabricated commitment backed only by the excerpt \"ok\" becomes an action item",
      !items.some((i) => JSON.stringify(i).includes("Wire Ada")),
      `action items: ${JSON.stringify(items.map((i) => (i as { title?: string; text?: string }).title ?? (i as { text?: string }).text))}`
    );
  } finally {
    await purgeUsers(db, [USER]);
  }

  t.done("relationship trivial excerpt (known bug)");
});
