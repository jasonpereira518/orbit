/**
 * Layers "engagement" onto the graph fixture so the constellation filter has something to
 * actually filter — a preview aid, not a test.
 *
 * `seed-graph-fixture` writes contacts with no interactions and no notes, which is exactly
 * the connections-only shape the filter hides entirely. That is worth SEEING (it is the
 * empty-sky path), but so is the normal case, so this gives roughly a third of the network
 * one of the qualifying signals apiece: notes, a meeting, a two-sided LinkedIn exchange.
 *
 * Run: DATABASE_URL= npx tsx scripts/seed-constellation-preview.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

if (process.env.DATABASE_URL?.trim()) {
  console.error("Local PGlite only — unset DATABASE_URL so writes stay off Neon.");
  process.exit(1);
}

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions } from "../src/db/schema";

const USER = "demo-user";

async function main() {
  const db = await getDb();
  const all = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
  await db.delete(interactions).where(eq(interactions.userId, USER));

  let notes = 0;
  let meetings = 0;
  let threads = 0;

  for (const [i, c] of all.entries()) {
    const bucket = i % 9;
    if (bucket === 0) {
      await db
        .update(contacts)
        .set({ notes: "Talked through their move into platform work." })
        .where(eq(contacts.id, c.id));
      notes++;
    } else if (bucket === 1) {
      await db.insert(interactions).values({
        userId: USER,
        contactId: c.id,
        interactionType: "note",
        rawNotes: "Coffee — they are hiring for two infra roles.",
        externalId: `preview-note-${i}`,
      });
      notes++;
    } else if (bucket === 2) {
      await db.insert(interactions).values({
        userId: USER,
        contactId: c.id,
        interactionType: "in_person",
        rawNotes: "Met at the meetup.",
        externalId: `preview-met-${i}`,
      });
      meetings++;
    } else if (bucket === 3) {
      for (let m = 0; m < 8; m++) {
        await db.insert(interactions).values({
          userId: USER,
          contactId: c.id,
          interactionType: "linkedin_message",
          direction: m % 2 === 0 ? "in" : "out",
          rawNotes: `Message ${m}`,
          externalId: `preview-msg-${i}-${m}`,
        });
      }
      threads++;
    }
  }

  console.log(
    `demo-user: ${all.length} contacts · ${notes} with notes · ${meetings} met · ${threads} with a real thread`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
