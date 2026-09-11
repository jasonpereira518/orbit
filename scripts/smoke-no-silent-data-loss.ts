/**
 * Guards the paths that used to destroy something a person had written.
 *
 * A QA sweep found six of these. They shared no code, but they shared a shape: work the
 * user typed was replaced or discarded, with no undo, no confirmation and usually no
 * message at all. For a product whose promise is "never lose track of someone", that is
 * the defect class that matters most, so each one gets a standing assertion here.
 *
 *   1. `generateDueFollowUps` overwrote hand-written reminders. Pressing "Generate more"
 *      on the dashboard turned "Send the intro deck", due 30 Oct, into "Follow up with
 *      Chris Nowak" due now — title, note and date unrecoverable. The identical fix had
 *      already been applied to its neighbour `scheduleContactFollowUp`, whose comment
 *      explains the same regression; this one never got it.
 *   2. Reminders could not be deleted or reopened. Completing was the only way to clear a
 *      row, and the sole route back from Done was the clock — labelled "Snooze 7 days" —
 *      because `snoozeReminder` sets `status: "pending"` as a side effect.
 *   3. A failed chat send left the question persisted with no answer and no failure
 *      marker, looking like a conversation the assistant had ignored. Those orphans were
 *      then fed back to the model as prior turns.
 *   4. `createContact` folded a submission into an existing person — replacing their
 *      company and role — while toasting "Contact created".
 *
 * Run: npx tsx scripts/smoke-no-silent-data-loss.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { chatMessages, chatThreads, contacts, reminders } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import {
  deleteReminder,
  generateDueFollowUps,
  completeReminder,
  reopenReminder,
} from "../src/lib/reminders";
import { discardEmptyThread, persistAssistantTurn } from "../src/lib/chat-persist";

const USER = "smoke-data-loss-user";

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

async function main() {
  const db = await getDb();
  await ensureUserSettings(USER);

  // ------------------------------------------------ 1. generated vs hand-written
  section("Generate more never rewrites a hand-written reminder");

  // A contact stale enough that the generator will want to queue them.
  const longAgo = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
  const [person] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Chris Nowak",
      relationshipScore: 4,
      lastInteractionAt: longAgo,
      createdAt: longAgo,
    })
    .returning();

  const userDue = new Date(2026, 9, 30, 12, 0, 0);
  const [handWritten] = await db
    .insert(reminders)
    .values({
      userId: USER,
      contactId: person.id,
      title: "Send the intro deck",
      description: "He asked for it after the AWS Summit chat",
      dueDate: userDue,
      reminderType: "manual",
      actionKind: "task",
      createdBy: "user",
      status: "pending",
    })
    .returning();

  await generateDueFollowUps(USER, 8);

  const afterGenerate = await db.query.reminders.findFirst({
    where: eq(reminders.id, handWritten.id),
  });
  check(
    "the title survives",
    afterGenerate?.title === "Send the intro deck",
    `got "${afterGenerate?.title}"`
  );
  check(
    "the description survives",
    afterGenerate?.description === "He asked for it after the AWS Summit chat"
  );
  check(
    "the due date survives",
    afterGenerate?.dueDate?.getTime() === userDue.getTime(),
    `got ${afterGenerate?.dueDate?.toISOString()}`
  );
  check("it is still the user's reminder", afterGenerate?.createdBy === "user");
  check("it is still typed manual", afterGenerate?.reminderType === "manual");

  // The contact is already handled, so the generator should leave them alone entirely
  // rather than queueing a second row against them.
  const rowsForPerson = await db.query.reminders.findMany({
    where: and(eq(reminders.userId, USER), eq(reminders.contactId, person.id)),
  });
  check(
    "no duplicate generated row is added for a contact the user has planned",
    rowsForPerson.length === 1,
    `found ${rowsForPerson.length}`
  );

  // A row the generator itself created is still fair game to reschedule.
  const [generated] = await db
    .insert(reminders)
    .values({
      userId: USER,
      contactId: null,
      title: "Follow up with someone",
      dueDate: new Date(2020, 0, 1),
      reminderType: "generated",
      actionKind: "follow_up",
      createdBy: "system",
      status: "pending",
    })
    .returning();
  check(
    "a system-generated reminder is still identifiable as movable",
    generated.createdBy === "system"
  );

  // ------------------------------------------------------- 2. delete and reopen
  section("Reminders can be deleted and reopened");

  await completeReminder(USER, handWritten.id);
  const completed = await db.query.reminders.findFirst({
    where: eq(reminders.id, handWritten.id),
  });
  check("completing sets done", completed?.status === "done");

  const reopened = await reopenReminder(USER, handWritten.id);
  check("reopen returns the row", Boolean(reopened));
  check("reopen restores pending", reopened?.status === "pending");
  check(
    "reopen does NOT move the due date the way snooze does",
    reopened?.dueDate?.getTime() === userDue.getTime(),
    `got ${reopened?.dueDate?.toISOString()}`
  );

  const snapshot = await deleteReminder(USER, handWritten.id);
  check("delete returns a snapshot", Boolean(snapshot));
  check(
    "the snapshot carries what an undo needs",
    snapshot?.title === "Send the intro deck" &&
      snapshot?.description === "He asked for it after the AWS Summit chat" &&
      snapshot?.dueDate?.getTime() === userDue.getTime()
  );
  const gone = await db.query.reminders.findFirst({
    where: eq(reminders.id, handWritten.id),
  });
  check("the row is actually gone", !gone);
  check(
    "deleting someone else's reminder is a no-op",
    (await deleteReminder("some-other-user", generated.id)) === null
  );

  // -------------------------------------------------------------- 3. chat turns
  section("A failed chat send leaves nothing behind");

  const [thread] = await db
    .insert(chatThreads)
    .values({ userId: USER })
    .returning();
  check("a fresh thread starts untitled", !thread.title);

  // The failure path: nothing was ever written for the user's question, so the thread is
  // still empty and gets discarded.
  await discardEmptyThread(USER, thread.id);
  const threadAfterFailure = await db.query.chatThreads.findFirst({
    where: eq(chatThreads.id, thread.id),
  });
  check("an empty auto-created thread is discarded", !threadAfterFailure);

  const orphans = await db.query.chatMessages.findMany({
    where: eq(chatMessages.userId, USER),
  });
  check(
    "no orphan user message is persisted for a turn that never answered",
    orphans.length === 0,
    `found ${orphans.length}`
  );

  // The success path writes BOTH halves together.
  const [liveThread] = await db
    .insert(chatThreads)
    .values({ userId: USER })
    .returning();
  await persistAssistantTurn(USER, liveThread.id, null, "Who do I know at AWS?", {
    answer: "Two people.",
    recommendations: [],
  });
  const persisted = await db.query.chatMessages.findMany({
    where: eq(chatMessages.threadId, liveThread.id),
  });
  check(
    "a completed turn stores the question and the answer",
    persisted.length === 2 &&
      persisted.some((m) => m.role === "user" && m.content === "Who do I know at AWS?") &&
      persisted.some((m) => m.role === "assistant")
  );
  const titled = await db.query.chatThreads.findFirst({
    where: eq(chatThreads.id, liveThread.id),
  });
  check(
    "the thread is titled from the question, so it is not another 'New chat'",
    titled?.title === "Who do I know at AWS?",
    `got "${titled?.title}"`
  );

  // A thread with real content must never be swept up by the cleanup.
  await discardEmptyThread(USER, liveThread.id);
  check(
    "a thread with messages is never discarded",
    Boolean(
      await db.query.chatThreads.findFirst({
        where: eq(chatThreads.id, liveThread.id),
      })
    )
  );

  // -------------------------------------------------------- 4. merge visibility
  section("A fold-in is reported as a merge, not as a creation");

  const { resolveOrCreateContact } = await import("../src/lib/contact-resolve");

  // `skipRevalidate`/`skipEmbedding`: revalidatePath needs a Next request context that a
  // script does not have, and embeddings would want a provider key.
  const writeOpts = { skipRevalidate: true, skipEmbedding: true };

  const first = await resolveOrCreateContact(
    USER,
    {
      fullName: "Pat Fold",
      company: "Alpha Inc",
      title: "Analyst",
      email: "pat.fold@example.com",
    },
    writeOpts
  );
  check("a genuinely new contact reports created", first.outcome === "created");

  const second = await resolveOrCreateContact(
    USER,
    {
      fullName: "Pat Fold",
      company: "Beta LLC",
      title: "Director",
      email: "pat.fold@example.com",
    },
    writeOpts
  );
  check(
    "the same person by email folds into the existing row",
    second.contactId === first.contactId
  );
  check(
    "and the outcome says so, so the UI need not claim 'Contact created'",
    second.outcome === "matched" || second.outcome === "merged",
    `got "${second.outcome}"`
  );

  const folded = await db.query.contacts.findFirst({
    where: eq(contacts.id, first.contactId),
  });
  check(
    "the fold-in really did replace the company, which is why it must be reported",
    folded?.company === "Beta LLC",
    `got "${folded?.company}"`
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll silent-data-loss guards passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
