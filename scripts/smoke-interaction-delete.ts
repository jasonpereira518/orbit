/**
 * Deleting one interaction.
 *
 * The row itself is trivial; the part worth a test is `contacts.last_interaction_at`. Every
 * other writer only ever stamps it forward, so this is the one path that has to walk it back
 * — and getting it wrong leaves a deleted touch propping up the recency half of the closeness
 * score forever, silently and invisibly.
 *
 * Writes to local PGlite. Stop this worktree's dev server first.
 * Run: npx tsx scripts/smoke-interaction-delete.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-interaction-delete";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-interaction-delete";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { actionItems, contacts, interactions, userSettings } from "../src/db/schema";
import { deleteInteractionForUser, logInteractionForUser } from "../src/lib/contact-writes";
import { run } from "./smoke/_env";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-interaction-delete-user";
/** Outside a request scope: `after()` and `revalidatePath` are not available here. */
const OPTS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true } as const;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  const [c] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Dana Whitfield" })
    .returning();

  const older = await logInteractionForUser(
    USER,
    { contactId: c.id, interactionType: "event", rawNotes: "Met at the Founded mixer", interactionDate: day("2026-06-01") },
    OPTS
  );
  const middle = await logInteractionForUser(
    USER,
    { contactId: c.id, interactionType: "meeting", rawNotes: "Coffee downtown", interactionDate: day("2026-07-15") },
    OPTS
  );
  const newest = await logInteractionForUser(
    USER,
    {
      contactId: c.id,
      interactionType: "intro",
      rawNotes: "She recommended Priya for the infra role",
      interactionDate: day("2026-08-20"),
      actionItems: ["Email Priya", "Send Dana the JD"],
    },
    OPTS
  );

  const stamped = await db.query.contacts.findFirst({ where: eq(contacts.id, c.id) });
  check(
    "logging stamps lastInteractionAt to the newest touch",
    stamped?.lastInteractionAt?.toISOString() === day("2026-08-20").toISOString(),
    String(stamped?.lastInteractionAt)
  );
  check(
    "action items were synced for the newest",
    (await db.query.actionItems.findMany({ where: eq(actionItems.interactionId, newest.id) })).length === 2
  );

  // Deleting an interaction that is NOT the latest must leave the stamp alone.
  await deleteInteractionForUser(USER, middle.id, OPTS);
  let contact = await db.query.contacts.findFirst({ where: eq(contacts.id, c.id) });
  check(
    "deleting a middle interaction leaves lastInteractionAt untouched",
    contact?.lastInteractionAt?.toISOString() === day("2026-08-20").toISOString(),
    String(contact?.lastInteractionAt)
  );

  // Deleting the latest must walk the stamp BACK to the newest survivor. This is the
  // regression the rest of the codebase cannot catch: every other writer moves it forward.
  await deleteInteractionForUser(USER, newest.id, OPTS);
  contact = await db.query.contacts.findFirst({ where: eq(contacts.id, c.id) });
  check(
    "deleting the latest walks lastInteractionAt back to the survivor",
    contact?.lastInteractionAt?.toISOString() === day("2026-06-01").toISOString(),
    String(contact?.lastInteractionAt)
  );
  check(
    "its action items went with it",
    (await db.query.actionItems.findMany({ where: eq(actionItems.interactionId, newest.id) })).length === 0
  );

  // Deleting the last one leaves nothing to date the relationship by.
  await deleteInteractionForUser(USER, older.id, OPTS);
  contact = await db.query.contacts.findFirst({ where: eq(contacts.id, c.id) });
  check(
    "the last deletion clears lastInteractionAt",
    contact?.lastInteractionAt === null,
    String(contact?.lastInteractionAt)
  );
  check(
    "no interactions remain",
    (await db.query.interactions.findMany({ where: eq(interactions.contactId, c.id) })).length === 0
  );

  // Ownership is enforced by the same userId-scoped lookup every other write path uses.
  const [survivor] = await db
    .insert(interactions)
    .values({ userId: USER, contactId: c.id, rawNotes: "not yours" })
    .returning();
  let refused = false;
  try {
    await deleteInteractionForUser("someone-else", survivor.id, OPTS);
  } catch {
    refused = true;
  }
  check("another user cannot delete it", refused);
  check(
    "and the row is still there",
    Boolean(await db.query.interactions.findFirst({ where: eq(interactions.id, survivor.id) }))
  );

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  console.log("\nsmoke-interaction-delete: all checks passed");
}

run(main);
