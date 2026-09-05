import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "./src/db";
import { actionItems, contacts, interactions } from "./src/db/schema";
import { eq } from "drizzle-orm";
import { actionItemHash } from "./src/lib/action-items";

const USER = "demo-user";
const day = (n: number) => new Date(Date.now() - n * 86400000);

// type, days ago, summary, notes?
const ROWS: Array<[string, number, string, string | null]> = [
  ["meeting", 1, "Walked through the Q4 roadmap and where Orbit fits.", "Long pasted notes would live here."],
  ["email", 2, "Sent the deck through, asked for intro to their design lead.", null],
  ["call", 4, "Quick call about the pilot timeline — they want Feb.", "Called at 3pm, 20 mins."],
  ["note", 6, "Reminder to self: they hate long email threads.", "Prefers a call."],
  ["in_person", 9, "Coffee near their office. Talked mostly about hiring.", "Blue Bottle on Hayes."],
  ["linkedin_message", 12, "Followed up on LinkedIn after the event.", null],
  ["reach_out", 15, "Cold-ish reach out about the partnership idea.", null],
  ["message", 20, "Texted about dinner plans, they were travelling.", null],
  ["event", 34, "Met at the AWS Summit after-party.", "Introduced by Dana."],
  ["intro", 41, "They introduced me to Maya at Stripe.", "Maya runs payments infra."],
  ["email", 55, "Thread about the contract redlines.", null],
  ["meeting", 70, "Kickoff with their whole team.", "Six people on the call."],
  // A deliberate silence: nothing between ~70 days and ~460 days.
  ["in_person", 462, "Dinner after the conference, first time meeting.", "Talked for three hours."],
  ["event", 470, "Sat next to them at the keynote.", null],
  ["note", 900, "Someone mentioned them as worth knowing.", null],
];

async function main() {
  const db = await getDb();

  await db.delete(contacts).where(eq(contacts.fullName, "Priya Raghavan"));

  const [contact] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Priya Raghavan",
      company: "Northwind",
      title: "VP Platform",
      relationshipScore: 4,
      source: "seed",
      howMet: "AWS Summit",
      aiSummary: "Platform VP at Northwind; met at the AWS Summit, now piloting.",
      lastInteractionAt: day(1),
      firstInteractionAt: day(900),
    })
    .returning();

  // Enough extra rows to push past the 40-row render window.
  const filler: Array<[string, number, string, string | null]> = [];
  for (let k = 0; k < 34; k += 1) {
    filler.push([
      ["email", "message", "linkedin_message", "call"][k % 4],
      75 + k * 3,
      `Routine exchange number ${k + 1} — enough rows to pass the window.`,
      k % 3 === 0 ? "Has notes." : null,
    ]);
  }

  const rows = [...ROWS.slice(0, 12), ...filler, ...ROWS.slice(12)];

  for (const [type, days, summary, notes] of rows) {
    const [row] = await db
      .insert(interactions)
      .values({
        userId: USER,
        contactId: contact.id,
        interactionType: type,
        interactionDate: day(days),
        aiSummary: summary,
        rawNotes: notes,
        source: "seed",
      })
      .returning();

    if (days === 1) {
      await db.insert(actionItems).values([
        { userId: USER, contactId: contact.id, interactionId: row.id, text: "Send the pilot SOW", position: 0, status: "open", itemHash: actionItemHash(row.id, "Send the pilot SOW") },
        { userId: USER, contactId: contact.id, interactionId: row.id, text: "Book the Feb kickoff", position: 1, status: "open", itemHash: actionItemHash(row.id, "Book the Feb kickoff") },
      ]);
    }
  }

  // A same-day pair, so the reorder controls have something to act on.
  await db.insert(interactions).values({
    userId: USER,
    contactId: contact.id,
    interactionType: "call",
    interactionDate: day(1),
    aiSummary: "Second touch the same day — a quick call after the meeting.",
    source: "seed",
  });

  console.log(`seeded ${contact.fullName} → /contacts/${contact.id} with ${rows.length + 1} interactions`);
  process.exit(0);
}

main();
