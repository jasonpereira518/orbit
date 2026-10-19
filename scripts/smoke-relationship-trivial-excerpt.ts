/**
 * The relationship engine's hallucination guard needs a meaningful excerpt.
 *
 * `locateExcerpt` (src/lib/relationship-engine/validate.ts) used to accept any non-empty
 * substring, so a model answer (or a sender's prompt injection) that invented a fact or a
 * commitment and cited "ok" — found inside "Looking forward to it" — was applied to the
 * contact's key facts and action items with no review. It now requires at least two words
 * and ten characters, matched on word boundaries, as a floor shared by every caller
 * (`validateDigest` → `processDigestAnswer`).
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-relationship-trivial-excerpt.ts
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
    t.check(
      "locateExcerpt rejects a 2-character excerpt (\"ok\" inside \"Looking\" is no match)",
      located === null,
      located ? `matched message: ${JSON.stringify(located.text)}` : ""
    );
    const v = validateDigest(answerWith("ok"), window, new Set());
    t.check(
      "validateDigest drops a fabricated fact whose excerpt is \"ok\"",
      !v.facts.includes(FABRICATED_FACT),
      `facts=${JSON.stringify(v.facts)}`
    );

    console.log("\n...and end to end (processDigestAnswer)...");
    const [runRow] = await db.insert(relationshipRuns).values({ userId: USER, status: "running" }).returning();
    await processDigestAnswer(USER, runRow.id, contact.id, window, answerWith("ok"), new Date("2026-09-02T09:00:00Z"));
    const [after] = await db.select({ keyFacts: contacts.keyFacts }).from(contacts).where(eq(contacts.id, contact.id));
    t.check(
      "a fabricated fact backed only by the excerpt \"ok\" is not written to the contact's key facts",
      !(after?.keyFacts ?? []).includes(FABRICATED_FACT),
      `key_facts=${JSON.stringify(after?.keyFacts)}`
    );
    const items = await db.select().from(actionItems).where(and(eq(actionItems.userId, USER), eq(actionItems.contactId, contact.id)));
    t.check(
      "a fabricated commitment backed only by the excerpt \"ok\" does not become an action item",
      !items.some((i) => JSON.stringify(i).includes("Wire Ada")),
      `action items: ${JSON.stringify(items.map((i) => (i as { title?: string; text?: string }).title ?? (i as { text?: string }).text))}`
    );
  } finally {
    await purgeUsers(db, [USER]);
  }

  t.done("relationship trivial excerpt");
});
