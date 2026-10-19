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
  dismissReminder,
  restoreDismissedReminder,
  generateDueFollowUps,
  completeReminder,
  reopenReminder,
} from "../src/lib/reminders";
import {
  discardEmptyThread,
  discardUnansweredQuestion,
  markTurnStopped,
  persistAssistantTurn,
  supersedeDanglingQuestion,
  wasTurnStopped,
} from "../src/lib/chat-persist";
import { persistInterruptedAnswer } from "../src/lib/chat-interrupted";

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

  // `completeReminder` returns a snapshot and `reopenReminder` takes it — main's shape,
  // which also restores the action items the completion closed. This branch's reopen took a
  // bare id and only moved the status back; main's is strictly more, so the test follows it.
  const snap = await completeReminder(USER, handWritten.id);
  const completed = await db.query.reminders.findFirst({
    where: eq(reminders.id, handWritten.id),
  });
  check("completing sets done", completed?.status === "done");
  check("completing returns a snapshot to undo with", Boolean(snap));

  const reopened = await reopenReminder(USER, snap!);
  check("reopen reports it restored something", reopened.restored);
  const afterReopen = await db.query.reminders.findFirst({
    where: eq(reminders.id, handWritten.id),
  });
  check("reopen restores pending", afterReopen?.status === "pending");
  check(
    "reopen does NOT move the due date the way snooze does",
    afterReopen?.dueDate?.getTime() === userDue.getTime(),
    `got ${afterReopen?.dueDate?.toISOString()}`
  );

  // Deleting a reminder is a soft dismiss with an undo, not a DELETE — see
  // `deleteReminderAction`. What matters for data loss is the same either way: the row the
  // user wrote has to survive the delete well enough to come back, and one account's
  // delete must not reach another's row.
  const snapshot = await dismissReminder(USER, handWritten.id);
  check("delete returns a snapshot", Boolean(snapshot));
  check(
    "the snapshot carries what an undo needs",
    snapshot?.reminderId === handWritten.id && snapshot?.previousStatus === "pending",
    JSON.stringify(snapshot)
  );
  const dismissed = await db.query.reminders.findFirst({
    where: eq(reminders.id, handWritten.id),
  });
  check("the row leaves the list", dismissed?.status === "dismissed");
  check(
    "and keeps every word the user wrote, so undo restores the reminder and not a stub",
    dismissed?.title === "Send the intro deck" &&
      dismissed?.description === "He asked for it after the AWS Summit chat" &&
      dismissed?.dueDate?.getTime() === userDue.getTime()
  );
  check(
    "undo brings it back as it was",
    (await restoreDismissedReminder(USER, snapshot!)).restored &&
      (
        await db.query.reminders.findFirst({ where: eq(reminders.id, handWritten.id) })
      )?.status === "pending"
  );
  check(
    "deleting someone else's reminder is a no-op",
    (await dismissReminder("some-other-user", generated.id)) === null
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

  // The question itself is written BEFORE the model runs — it carries the people attached
  // to it, and a regenerate has to write it into the slot being versioned — so the failure
  // path has to clear it rather than never having written it. An unanswered question left
  // in the thread reads as a question the assistant ignored, and `prepareChatContext` feeds
  // the last eight messages back to the model, so it also poisons the next real answer.
  const [failedThread] = await db.insert(chatThreads).values({ userId: USER }).returning();
  const [asked] = await db
    .insert(chatMessages)
    .values({ threadId: failedThread.id, userId: USER, role: "user", content: "Who do I know at AWS?" })
    .returning();
  await discardUnansweredQuestion(USER, failedThread.id, asked.id);
  const orphans = await db.query.chatMessages.findMany({
    where: eq(chatMessages.userId, USER),
  });
  check(
    "no orphan user message is persisted for a turn that never answered",
    orphans.length === 0,
    `found ${orphans.length}`
  );

  // The success path keeps both halves — and the question is NOT discarded once an answer
  // sits under it, whatever happened on an earlier attempt.
  const [liveThread] = await db
    .insert(chatThreads)
    .values({ userId: USER })
    .returning();
  const [answered] = await db
    .insert(chatMessages)
    .values({ threadId: liveThread.id, userId: USER, role: "user", content: "Who do I know at AWS?" })
    .returning();
  await persistAssistantTurn(USER, liveThread.id, null, "Who do I know at AWS?", {
    answer: "Two people.",
    recommendations: [],
  });
  await discardUnansweredQuestion(USER, liveThread.id, answered.id);
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

  // Stop versus a dropped connection (audit L-25). Both reach the server as the same abort;
  // a dropped one keeps the question, and only a Stop the client reports discards it, in
  // whichever order the Stop and the route's own check arrive.
  {
    const ask = async (threadId: string, turnId: string, content = "Who do I know at Stripe?") =>
      (await db
        .insert(chatMessages)
        .values({ threadId, userId: USER, role: "user", content, clientTurnId: turnId })
        .returning())[0];
    const rowsIn = async (threadId: string) =>
      db.query.chatMessages.findMany({ where: eq(chatMessages.threadId, threadId) });

    // Dropped: nobody marks the turn, so the route keeps it.
    const [dropped] = await db.insert(chatThreads).values({ userId: USER }).returning();
    await persistAssistantTurn(USER, dropped.id, null, "Earlier question", { answer: "Earlier answer.", recommendations: [] });
    const droppedTurn = crypto.randomUUID();
    await ask(dropped.id, droppedTurn);
    check("a dropped connection is not read as a Stop", !(await wasTurnStopped(USER, dropped.id, droppedTurn)));
    check("so the question the person typed is still in the thread",
      (await rowsIn(dropped.id)).some((m) => m.role === "user" && m.content === "Who do I know at Stripe?"));

    // Asking again replaces the kept copy instead of showing the question twice.
    await supersedeDanglingQuestion(USER, dropped.id, "Who do I know at Stripe?");
    const afterReask = await rowsIn(dropped.id);
    check("asking again drops the unanswered copy, and only it",
      !afterReask.some((m) => m.content === "Who do I know at Stripe?") && afterReask.length === 1,
      `${afterReask.length} rows`);
    await ask(dropped.id, crypto.randomUUID(), "Something else entirely");
    await supersedeDanglingQuestion(USER, dropped.id, "Who do I know at Stripe?");
    check("a different question is never superseded",
      (await rowsIn(dropped.id)).some((m) => m.content === "Something else entirely"));

    // Stop lands AFTER the route saved the question and kept it: the Stop removes it.
    const [late] = await db.insert(chatThreads).values({ userId: USER }).returning();
    await persistAssistantTurn(USER, late.id, null, "Earlier question", { answer: "Earlier answer.", recommendations: [] });
    const lateTurn = crypto.randomUUID();
    await ask(late.id, lateTurn);
    await markTurnStopped(USER, late.id, lateTurn);
    check("a Stop that arrives late still discards the question",
      !(await rowsIn(late.id)).some((m) => m.content === "Who do I know at Stripe?"));

    // Stop lands BEFORE the question is saved: the route's check sees the mark.
    const [early] = await db.insert(chatThreads).values({ userId: USER }).returning();
    await persistAssistantTurn(USER, early.id, null, "Earlier question", { answer: "Earlier answer.", recommendations: [] });
    const earlyTurn = crypto.randomUUID();
    await markTurnStopped(USER, early.id, earlyTurn);
    await ask(early.id, earlyTurn);
    check("a Stop that arrives first is seen by the route", await wasTurnStopped(USER, early.id, earlyTurn));
    check("and a later turn is not mistaken for it", !(await wasTurnStopped(USER, early.id, crypto.randomUUID())));

    // Stop on a first message empties the thread, which goes too.
    const [first] = await db.insert(chatThreads).values({ userId: USER }).returning();
    const firstTurn = crypto.randomUUID();
    await ask(first.id, firstTurn);
    await markTurnStopped(USER, first.id, firstTurn);
    check("a Stop on the first message leaves no empty 'New chat'",
      !(await db.query.chatThreads.findFirst({ where: eq(chatThreads.id, first.id) })));

    // The part of an answer that streamed before a drop is kept, marked cut off, and
    // cleaned like a finished one: an invented citation or a block the server never
    // offered does not survive into storage.
    const emptyBlocks = { people: {}, lists: {} } as never;
    const [partial] = await db.insert(chatThreads).values({ userId: USER }).returning();
    const partialTurn = crypto.randomUUID();
    await ask(partial.id, partialTurn);
    await persistInterruptedAnswer({
      userId: USER, threadId: partial.id, turnId: partialTurn, question: "Who do I know at Stripe?", title: null,
      answer: "Ana Ruiz runs payments [e99] and", evidence: {}, blocks: emptyBlocks, activity: [],
    });
    const partialRows = await rowsIn(partial.id);
    const kept = partialRows.find((m) => m.role === "assistant");
    check("a dropped answer is kept as far as it streamed, marked interrupted",
      Boolean(kept?.interrupted) && Boolean(kept?.content.startsWith("Ana Ruiz runs payments")), JSON.stringify(kept?.content));
    check("an invented citation is stripped before it is stored", !kept?.content.includes("[e99]"));
    check("the question it answers is still there", partialRows.some((m) => m.role === "user"));

    // Asking again replaces the kept question AND its partial answer.
    await supersedeDanglingQuestion(USER, partial.id, "Who do I know at Stripe?");
    check("a re-ask replaces both the kept question and its partial answer", (await rowsIn(partial.id)).length === 0);

    // A Stop that lands after the partial answer was saved discards both.
    const [stoppedLate] = await db.insert(chatThreads).values({ userId: USER }).returning();
    await persistAssistantTurn(USER, stoppedLate.id, null, "Earlier question", { answer: "Earlier answer.", recommendations: [] });
    const stoppedLateTurn = crypto.randomUUID();
    await ask(stoppedLate.id, stoppedLateTurn);
    await persistInterruptedAnswer({
      userId: USER, threadId: stoppedLate.id, turnId: stoppedLateTurn, question: "Who do I know at Stripe?", title: null,
      answer: "Half an answer", evidence: {}, blocks: emptyBlocks, activity: [],
    });
    await markTurnStopped(USER, stoppedLate.id, stoppedLateTurn);
    const afterStop = await rowsIn(stoppedLate.id);
    check("a late Stop removes the partial answer and its question, and nothing older",
      afterStop.length === 1 && afterStop[0]!.content === "Earlier answer.", JSON.stringify(afterStop.map((m) => m.content)));

    // A Stop marked before the save: the save itself sees the mark and backs out.
    const [stoppedFirst] = await db.insert(chatThreads).values({ userId: USER }).returning();
    await persistAssistantTurn(USER, stoppedFirst.id, null, "Earlier question", { answer: "Earlier answer.", recommendations: [] });
    const stoppedFirstTurn = crypto.randomUUID();
    await ask(stoppedFirst.id, stoppedFirstTurn);
    await db.update(chatThreads).set({ stoppedTurnId: stoppedFirstTurn }).where(eq(chatThreads.id, stoppedFirst.id));
    await persistInterruptedAnswer({
      userId: USER, threadId: stoppedFirst.id, turnId: stoppedFirstTurn, question: "Who do I know at Stripe?", title: null,
      answer: "Half an answer", evidence: {}, blocks: emptyBlocks, activity: [],
    });
    check("a Stop that raced the save still leaves nothing of the turn",
      (await rowsIn(stoppedFirst.id)).length === 1);

    // A finished answer is never touched by a Stop for its turn id.
    const [finished] = await db.insert(chatThreads).values({ userId: USER }).returning();
    const finishedTurn = crypto.randomUUID();
    await ask(finished.id, finishedTurn);
    await persistAssistantTurn(USER, finished.id, null, "Who do I know at Stripe?", { answer: "Two people.", recommendations: [] });
    await markTurnStopped(USER, finished.id, finishedTurn);
    check("a Stop after the answer finished deletes nothing", (await rowsIn(finished.id)).length === 2);

    // Someone else's Stop reaches nothing.
    const [mine] = await db.insert(chatThreads).values({ userId: USER }).returning();
    const mineTurn = crypto.randomUUID();
    await ask(mine.id, mineTurn);
    await markTurnStopped("someone-else", mine.id, mineTurn);
    check("another account cannot stop (and delete) this question",
      (await rowsIn(mine.id)).length === 1 && !(await wasTurnStopped(USER, mine.id, mineTurn)));
  }

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

  // Clean up after ourselves.
  //
  // The pglite tier shares one database, and `smoke-admin-analytics` asserts a GLOBAL
  // aggregate — `engagementDepth` counts chat messages across every user, and expects
  // exactly the two it wrote. The threads and messages this script inserted were left
  // behind, so it failed whenever it ran after this one: passing alone, failing in the
  // suite. Deleting the threads cascades to their messages.
  await db.delete(chatThreads).where(eq(chatThreads.userId, USER));
  await db.delete(chatMessages).where(eq(chatMessages.userId, USER));
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));

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
