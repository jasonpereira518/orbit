/**
 * Committing and dismissing a chat-proposed action (`src/actions/chat-actions.ts`).
 *
 * What has to hold: a double click (or two tabs) commits exactly once, thanks to the
 * compare-and-swap claim; the write itself comes from the STORED row, never from anything the
 * client sends; a contact deleted between propose and click fails the write and releases the
 * claim rather than stranding the card; and every one of the three action kinds actually
 * produces the record it says it will.
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
import { validateProposedActions, type StoredProposedAction } from "../src/lib/chat-proposed-actions";
import { commitProposedAction, dismissProposedAction } from "../src/actions/chat-actions";

const USER = "demo-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function seedMessage(rawActions: (contactId: string) => unknown[]) {
  const db = await getDb();
  const [thread] = await db.insert(chatThreads).values({ userId: USER }).returning();
  const [contact] = await db.insert(contacts).values({ userId: USER, fullName: "Ada Lovelace" }).returning();
  const actions = validateProposedActions(rawActions(contact!.id), new Set([contact!.id]), new Map([[contact!.id, "Ada Lovelace"]]));
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

  console.log("committing log_interaction");
  {
    const { messageId, contactId, actions } = await seedMessage((cid) => [
      { kind: "log_interaction", contact_id: cid, text: "Talked about the Series A." },
    ]);
    // Re-key the placeholder to the real contact id (validateProposedActions needed a real
    // allowlisted id, seeded before we knew it here).
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
    const { messageId, actions } = await seedMessage(() => [
      { kind: "create_reminder", contact_id: null, title: "Renew the domain", due_date: null },
    ]);
    const res = await commitProposedAction(messageId, actions[0]!.id);
    check("commits", res.ok === true, JSON.stringify(res));
    const created = res.ok && res.resultId ? await db.query.reminders.findFirst({ where: eq(reminders.id, res.resultId) }) : null;
    check("the reminder exists with the exact title", created?.title === "Renew the domain");
    check("undated reminders have no due date", created?.dueDate === null);
  }

  console.log("committing schedule_follow_up");
  {
    const { messageId, contactId, actions } = await seedMessage((cid) => [{ kind: "schedule_follow_up", contact_id: cid, days: 5 }]);
    const res = await commitProposedAction(messageId, actions[0]!.id);
    check("commits", res.ok === true, JSON.stringify(res));
    const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId) });
    check("the contact's follow-up clock moved", Boolean(contact?.nextFollowUpAt));
  }

  console.log("a double click races to commit exactly once");
  {
    const { messageId, actions } = await seedMessage(() => [{ kind: "create_reminder", contact_id: null, title: "Race test" }]);
    const [a, b] = await Promise.all([commitProposedAction(messageId, actions[0]!.id), commitProposedAction(messageId, actions[0]!.id)]);
    const oks = [a, b].filter((r) => r.ok);
    check("exactly one of two simultaneous commits succeeds", oks.length === 1, JSON.stringify([a, b]));
    const matching = await db.query.reminders.findMany({ where: eq(reminders.title, "Race test") });
    check("exactly one reminder was created, not two", matching.length === 1, JSON.stringify(matching.map((r) => r.id)));
  }

  console.log("dismissing");
  {
    const { messageId, actions } = await seedMessage(() => [{ kind: "create_reminder", contact_id: null, title: "Never mind" }]);
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
    const { actions } = await seedMessage(() => [{ kind: "create_reminder", contact_id: null, title: "x" }]);
    const wrongMessage = await commitProposedAction("00000000-0000-4000-8000-000000000000", actions[0]!.id);
    check("a message id that does not exist is refused", wrongMessage.ok === false);
    const wrongAction = await seedMessage(() => [{ kind: "create_reminder", contact_id: null, title: "y" }]);
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
        proposedActions: [{ id: "a1", args: { kind: "create_reminder", contactId: null, title: "Not yours", description: null, dueDate: null }, preview: "x", status: "proposed" } satisfies StoredProposedAction],
      })
      .returning();
    const res = await commitProposedAction(foreignMsg!.id, "a1");
    check("refused — the message is scoped to its own user, not just its id", res.ok === false);
  }

  console.log("a contact deleted between propose and click fails the write and releases the claim");
  {
    const db2 = await getDb();
    const [c] = await db2.insert(contacts).values({ userId: USER, fullName: "About To Vanish" }).returning();
    const [thread] = await db2.insert(chatThreads).values({ userId: USER }).returning();
    const actions = validateProposedActions([{ kind: "schedule_follow_up", contact_id: c!.id }], new Set([c!.id]), new Map([[c!.id, "About To Vanish"]]));
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
