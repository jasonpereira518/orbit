/**
 * Committing and dismissing a chat-proposed action (`src/actions/chat-actions.ts`).
 *
 * What has to hold: a double click (or two tabs) commits exactly once, thanks to the
 * compare-and-swap claim; the write itself comes from the STORED row, never from anything the
 * client sends; a contact deleted between propose and click fails the write and releases the
 * claim rather than stranding the card; and each write it covers actually produces the record
 * it says it will, through its catalog entry (@/lib/tools/chat-writes).
 *
 * Local PGlite. Run: npx tsx scripts/smoke-chat-actions.ts
 */
import "./smoke/_env";
// These actions go through `requireUserId()`. With no Clerk keys AND NODE_ENV=development,
// that resolves to demo mode's `demo-user` — the identity seeded below.
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { chatMessages, chatThreads, contacts, interactions, reminders } from "../src/db/schema";
import type { StoredProposedAction } from "../src/lib/chat-proposed-actions";
import { createProposalSink } from "../src/lib/tools/chat-proposals";
import { commitProposedAction, dismissProposedAction } from "../src/actions/chat-actions";
import { createReminderForUser } from "../src/lib/reminder-writes";

const USER = "demo-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/**
 * Cards as the answer loop stores them: each `[write, input]` proposed through a sink that has
 * seen these contacts and reminders, exactly as a turn's lookups would have shown them.
 */
function cards(
  proposals: Array<[string, Record<string, unknown>]>,
  seen: { contacts?: Map<string, string>; reminders?: Map<string, string> } = {}
): StoredProposedAction[] {
  const sink = createProposalSink(seen);
  for (const [tool, input] of proposals) {
    const out = sink.propose(tool, input);
    if (!out.ok) throw new Error(`could not propose ${tool}: ${out.error}`);
  }
  return sink.list();
}

async function seedMessage(proposals: (contactId: string) => Array<[string, Record<string, unknown>]>) {
  const db = await getDb();
  const [thread] = await db.insert(chatThreads).values({ userId: USER }).returning();
  const [contact] = await db.insert(contacts).values({ userId: USER, fullName: "Ada Lovelace" }).returning();
  const actions = cards(proposals(contact!.id), { contacts: new Map([[contact!.id, "Ada Lovelace"]]) });
  const [msg] = await db
    .insert(chatMessages)
    .values({ threadId: thread!.id, userId: USER, role: "assistant", content: "Here's what I found.", proposedActions: actions })
    .returning();
  return { messageId: msg!.id, contactId: contact!.id, actions };
}

async function main() {
  const db = await getDb();
  await db.delete(chatThreads).where(eq(chatThreads.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));

  console.log("committing log_note");
  {
    const { messageId, contactId, actions } = await seedMessage((cid) => [["log_note", { contactId: cid, text: "Talked about the Series A." }]]);
    const action = actions[0]!;
    const res = await commitProposedAction(messageId, action.id);
    check("commits", res.ok === true, JSON.stringify(res));
    const row = await db.query.chatMessages.findFirst({ where: eq(chatMessages.id, messageId) });
    const stored = row?.proposedActions?.[0];
    check("status flips to done", stored?.status === "done");
    check("carries the created interaction's id as resultId", res.ok && res.resultId === stored?.resultId && typeof stored?.resultId === "string");
    const created = await db.query.interactions.findFirst({ where: eq(interactions.contactId, contactId) });
    check("the interaction actually exists", Boolean(created));
    check("with the exact text proposed, not re-derived", created?.rawNotes === "Talked about the Series A.");
    check("keyed for idempotency", created?.externalId === `chat:${messageId}:${action.id}`);
    check("direction is out — this is the user's own note", created?.direction === "out");

    console.log("committing again is refused, and creates nothing twice");
    const again = await commitProposedAction(messageId, action.id);
    check("refused", again.ok === false);
    const count = await db.query.interactions.findMany({ where: eq(interactions.contactId, contactId) });
    check("still exactly one interaction", count.length === 1);
  }

  console.log("committing create_reminder");
  {
    const { messageId, actions } = await seedMessage(() => [["create_reminder", { title: "Renew the domain" }]]);
    const res = await commitProposedAction(messageId, actions[0]!.id);
    check("commits", res.ok === true, JSON.stringify(res));
    const created = res.ok && res.resultId ? await db.query.reminders.findFirst({ where: eq(reminders.id, res.resultId) }) : null;
    check("the reminder exists with the exact title", created?.title === "Renew the domain");
    check("undated reminders have no due date", created?.dueDate === null);
  }

  console.log("committing schedule_follow_up");
  {
    const { messageId, contactId, actions } = await seedMessage((cid) => [["schedule_follow_up", { contactId: cid, days: 5 }]]);
    const res = await commitProposedAction(messageId, actions[0]!.id);
    check("commits", res.ok === true, JSON.stringify(res));
    const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId) });
    check("the contact's follow-up clock moved", Boolean(contact?.nextFollowUpAt));
  }

  console.log("a double click races to commit exactly once");
  {
    const { messageId, actions } = await seedMessage(() => [["create_reminder", { title: "Race test" }]]);
    const [a, b] = await Promise.all([commitProposedAction(messageId, actions[0]!.id), commitProposedAction(messageId, actions[0]!.id)]);
    const oks = [a, b].filter((r) => r.ok);
    check("exactly one of two simultaneous commits succeeds", oks.length === 1, JSON.stringify([a, b]));
    const matching = await db.query.reminders.findMany({ where: eq(reminders.title, "Race test") });
    check("exactly one reminder was created, not two", matching.length === 1, JSON.stringify(matching.map((r) => r.id)));
  }

  console.log("dismissing");
  {
    const { messageId, actions } = await seedMessage(() => [["create_reminder", { title: "Never mind" }]]);
    const res = await dismissProposedAction(messageId, actions[0]!.id);
    check("dismisses", res.ok === true);
    const row = await db.query.chatMessages.findFirst({ where: eq(chatMessages.id, messageId) });
    check("status is dismissed", row?.proposedActions?.[0]?.status === "dismissed");
    check("nothing was written", (await db.query.reminders.findMany({ where: eq(reminders.title, "Never mind") })).length === 0);
    const again = await commitProposedAction(messageId, actions[0]!.id);
    check("a dismissed action cannot then be committed", again.ok === false);
  }

  console.log("what must fail");
  {
    const { actions } = await seedMessage(() => [["create_reminder", { title: "x" }]]);
    const wrongMessage = await commitProposedAction("00000000-0000-4000-8000-000000000000", actions[0]!.id);
    check("a message id that does not exist is refused", wrongMessage.ok === false);
    const wrongAction = await seedMessage(() => [["create_reminder", { title: "y" }]]);
    const wrongId = await commitProposedAction(wrongAction.messageId, "00000000-0000-4000-8000-000000000000");
    check("an action id that does not exist on that message is refused", wrongId.ok === false);
  }

  console.log("a foreign message cannot be committed from this account");
  {
    const [foreignThread] = await db.insert(chatThreads).values({ userId: "someone-else" }).returning();
    const [foreignMsg] = await db
      .insert(chatMessages)
      .values({
        threadId: foreignThread!.id,
        userId: "someone-else",
        role: "assistant",
        content: "x",
        proposedActions: [{ id: "a1", args: { kind: "tool", tool: "create_reminder", input: { title: "Not yours" } }, preview: "x", status: "proposed" } satisfies StoredProposedAction],
      })
      .returning();
    const res = await commitProposedAction(foreignMsg!.id, "a1");
    check("refused — the message is scoped to its own user, not just its id", res.ok === false);
  }

  console.log("committing update_contact, create_contact, complete_reminder and snooze_reminder");
  {
    const reminder = await createReminderForUser(USER, { title: "Send Ada the deck", reminderType: "manual" });
    const reminder2 = await createReminderForUser(USER, { title: "Book the venue", reminderType: "manual" });
    const db2 = await getDb();
    const [thread] = await db2.insert(chatThreads).values({ userId: USER }).returning();
    const [c] = await db2.insert(contacts).values({ userId: USER, fullName: "Grace Hopper", title: "Engineer" }).returning();
    const all = cards(
      [
        ["update_contact", { contactId: c!.id, title: "Rear Admiral", company: "US Navy" }],
        ["create_contact", { full_name: "Katherine Johnson", title: "Mathematician", email: "kj@nasa.example" }],
        ["complete_reminder", { reminderId: reminder!.id }],
        ["snooze_reminder", { reminderId: reminder2!.id, days: 3 }],
      ],
      {
        contacts: new Map([[c!.id, "Grace Hopper"]]),
        reminders: new Map([[reminder!.id, reminder!.title], [reminder2!.id, reminder2!.title]]),
      }
    );
    const [msg] = await db2.insert(chatMessages).values({ threadId: thread!.id, userId: USER, role: "assistant", content: "x", proposedActions: all }).returning();
    const results = [];
    for (const a of all) results.push(await commitProposedAction(msg!.id, a.id));
    check("all four commit", results.every((r) => r.ok), JSON.stringify(results));

    const grace = await db2.query.contacts.findFirst({ where: eq(contacts.id, c!.id) });
    check("update_contact wrote exactly the proposed fields", grace?.title === "Rear Admiral" && grace?.company === "US Navy", JSON.stringify(grace && { title: grace.title, company: grace.company }));
    const kj = await db2.query.contacts.findFirst({ where: and(eq(contacts.userId, USER), eq(contacts.fullName, "Katherine Johnson")) });
    check("create_contact created the person", kj?.title === "Mathematician");
    check("and its resultId is the new contact", results[1]!.ok && results[1]!.resultId === kj?.id);
    const done = await db2.query.reminders.findFirst({ where: eq(reminders.id, reminder!.id) });
    check("complete_reminder completed it", done?.status === "done", JSON.stringify(done && { status: done.status }));
    const snoozed = await db2.query.reminders.findFirst({ where: eq(reminders.id, reminder2!.id) });
    check("snooze_reminder pushed it out ~3 days", Boolean(snoozed?.dueDate) && new Date(snoozed!.dueDate!).getTime() > Date.now() + 2 * 86_400_000, JSON.stringify(snoozed?.dueDate));

    console.log("adding someone already in the network is refused, not doubled");
    const dupe = cards([["create_contact", { full_name: "Katherine Johnson", email: "kj@nasa.example" }]]);
    const [msg2] = await db2.insert(chatMessages).values({ threadId: thread!.id, userId: USER, role: "assistant", content: "x", proposedActions: dupe }).returning();
    const res = await commitProposedAction(msg2!.id, dupe[0]!.id);
    check("the commit fails with a reason a person can read", res.ok === false && /already in your contacts/.test(res.reason), JSON.stringify(res));
    const kjs = await db2.query.contacts.findMany({ where: and(eq(contacts.userId, USER), eq(contacts.fullName, "Katherine Johnson")) });
    check("still one Katherine Johnson", kjs.length === 1, String(kjs.length));
  }

  console.log("a contact deleted between propose and click fails the write and releases the claim");
  {
    const db2 = await getDb();
    const [c] = await db2.insert(contacts).values({ userId: USER, fullName: "About To Vanish" }).returning();
    const [thread] = await db2.insert(chatThreads).values({ userId: USER }).returning();
    const actions = cards([["schedule_follow_up", { contactId: c!.id, days: 7 }]], { contacts: new Map([[c!.id, "About To Vanish"]]) });
    const [msg] = await db2.insert(chatMessages).values({ threadId: thread!.id, userId: USER, role: "assistant", content: "x", proposedActions: actions }).returning();
    await db2.delete(contacts).where(and(eq(contacts.id, c!.id), eq(contacts.userId, USER)));
    const res = await commitProposedAction(msg!.id, actions[0]!.id);
    check("the commit fails rather than throwing uncaught", res.ok === false);
    const row = await db2.query.chatMessages.findFirst({ where: eq(chatMessages.id, msg!.id) });
    check("the claim is released back to proposed, so a retry is possible", row?.proposedActions?.[0]?.status === "proposed");
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll chat action checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
