/**
 * Completing a reminder from the extension panel, and undoing it.
 *
 * The defect this guards: a follow-up lives in two places — the reminders row
 * and `contacts.nextFollowUpAt` — and the panel's overdue banner reads the
 * contact column. Completing only the row left "Follow-up was due 3 weeks ago"
 * on screen above the thing the user had just marked done. The app's
 * `clearContactFollowUp` would fix that by completing EVERY pending reminder
 * for the contact, which is the opposite mistake. So these checks pin all four
 * edges:
 *
 *   1. the follow-up reminder clears the contact's clock with it
 *   2. an unrelated reminder does NOT touch the clock
 *   3. the contact's OTHER open reminders stay open
 *   4. Undo restores the clock — unless a newer follow-up was set meanwhile
 *
 * Plus tenancy: another user's reminder id is "not found", never completed.
 *
 * Run: npx tsx scripts/smoke-extension-reminders.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, reminders } from "../src/db/schema";
import {
  completeReminderFromExtension,
  reopenReminderFromExtension,
} from "../src/lib/extension/reminders";

// Deliberately not `demo-user`: nothing here should depend on demo-mode grants.
const USER = "smoke-ext-reminders-user";
const OTHER = "smoke-ext-reminders-other";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

async function cleanup() {
  const db = await getDb();
  for (const user of [USER, OTHER]) {
    await db.delete(reminders).where(eq(reminders.userId, user));
    await db.delete(contacts).where(eq(contacts.userId, user));
  }
}

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setMilliseconds(0);
  return d;
}

/** A contact with a follow-up: the column and its reminder share one instant. */
async function seedFollowUp(userId: string, name: string) {
  const db = await getDb();
  const due = daysAgo(21);
  const [contact] = await db
    .insert(contacts)
    .values({ userId, fullName: name, nextFollowUpAt: due, followUpStatus: "pending" })
    .returning();
  const [followUp] = await db
    .insert(reminders)
    .values({
      userId,
      contactId: contact.id,
      title: `Follow up with ${name}`,
      dueDate: due,
      createdBy: "extension",
    })
    .returning();
  const [other] = await db
    .insert(reminders)
    .values({
      userId,
      contactId: contact.id,
      title: "Send the payments RFC",
      dueDate: daysAgo(-3),
    })
    .returning();
  return { contact, followUp, other, due };
}

async function contactClock(id: string) {
  const db = await getDb();
  const row = await db.query.contacts.findFirst({
    where: eq(contacts.id, id),
    columns: { nextFollowUpAt: true, followUpStatus: true },
  });
  return row;
}

async function statusOf(id: string) {
  const db = await getDb();
  const row = await db.query.reminders.findFirst({
    where: eq(reminders.id, id),
    columns: { status: true },
  });
  return row?.status;
}

async function main() {
  await cleanup();

  console.log("1. completing the follow-up reminder clears the contact's clock");
  const a = await seedFollowUp(USER, "Amara Osei");
  const completion = await completeReminderFromExtension(USER, a.followUp.id);
  check("the reminder is done", (await statusOf(a.followUp.id)) === "done");
  const cleared = await contactClock(a.contact.id);
  check("the contact's follow-up clock is cleared", cleared?.nextFollowUpAt === null);
  check("…and its status says so", cleared?.followUpStatus === "none");
  check(
    "the completion records the instant it cleared, for Undo",
    completion.clearedFollowUpAt === a.due.toISOString(),
    String(completion.clearedFollowUpAt)
  );

  console.log("3. the contact's other open reminders stay open");
  check(
    "an unrelated reminder on the same contact is still pending",
    (await statusOf(a.other.id)) === "pending"
  );

  console.log("4a. Undo restores the reminder AND the clock");
  const undo = await reopenReminderFromExtension(USER, completion);
  check("undo reports it restored", undo.restored);
  check("the reminder is pending again", (await statusOf(a.followUp.id)) === "pending");
  const restored = await contactClock(a.contact.id);
  check(
    "the clock is back at its original instant",
    restored?.nextFollowUpAt?.getTime() === a.due.getTime()
  );

  console.log("2. completing an UNRELATED reminder never touches the clock");
  const unrelated = await completeReminderFromExtension(USER, a.other.id);
  check("no clock was cleared", unrelated.clearedFollowUpAt === null);
  check(
    "the contact still has its follow-up",
    (await contactClock(a.contact.id))?.nextFollowUpAt?.getTime() === a.due.getTime()
  );

  console.log("4b. Undo never overwrites a follow-up set since");
  const b = await seedFollowUp(USER, "Ben Tate");
  const bCompletion = await completeReminderFromExtension(USER, b.followUp.id);
  const fresh = daysAgo(-10);
  const db = await getDb();
  await db
    .update(contacts)
    .set({ nextFollowUpAt: fresh, followUpStatus: "pending" })
    .where(and(eq(contacts.id, b.contact.id), eq(contacts.userId, USER)));
  await reopenReminderFromExtension(USER, bCompletion);
  check(
    "the newer follow-up survives the undo",
    (await contactClock(b.contact.id))?.nextFollowUpAt?.getTime() === fresh.getTime()
  );

  console.log("tenancy");
  const c = await seedFollowUp(OTHER, "Chioma Eze");
  let threw = "";
  try {
    await completeReminderFromExtension(USER, c.followUp.id);
  } catch (error) {
    threw = (error as { code?: string }).code ?? "unknown";
  }
  check("another user's reminder is not_found", threw === "not_found", threw);
  check("…and it was not completed", (await statusOf(c.followUp.id)) === "pending");
  check(
    "…and their clock was not touched",
    (await contactClock(c.contact.id))?.nextFollowUpAt?.getTime() === c.due.getTime()
  );
  const undoForeign = await reopenReminderFromExtension(USER, {
    ...bCompletion,
    reminderId: c.followUp.id,
    contactId: c.contact.id,
  });
  check("undo cannot be aimed at another user's reminder", !undoForeign.restored);

  await cleanup();
  if (failures) {
    console.error(`\nsmoke-extension-reminders: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nsmoke-extension-reminders: all checks passed");
  process.exit(0);
}

main().catch(async (error) => {
  console.error(error);
  await cleanup().catch(() => {});
  process.exit(1);
});
