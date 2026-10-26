/**
 * The chat writes, end to end: proposed through the loop's proposer tools
 * (`src/lib/tools/chat-proposals.ts`), stored on a message, committed by a person's click
 * (`commitProposedAction`), and undone (`undoProposedAction`). Plus the fences: an id the turn
 * never saw is refused at propose time, a tampered stored row is refused at commit time, and
 * none of this reaches the chat surface as a write.
 *
 * PGlite, demo mode (no Clerk), no AI key. Run: npx tsx scripts/smoke-chat-writes.ts
 */
import "./smoke/_env";
// The server actions resolve the caller through Clerk; without keys that is demo mode's
// `demo-user`, the identity seeded below — the same arrangement as smoke-chat-actions.
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  actionItems,
  chatMessages,
  chatThreads,
  contactTags,
  contacts,
  eventAttendees,
  events,
  interactions,
  reminders,
  tags,
} from "../src/db/schema";
import { commitProposedAction, undoProposedAction } from "../src/actions/chat-actions";
import { updateContactForUser } from "../src/lib/contact-writes";
import type { StoredProposedAction } from "../src/lib/chat-proposed-actions";
import { createProposalSink, MAX_PROPOSALS, proposerTools } from "../src/lib/tools/chat-proposals";
import { CHAT_WRITES } from "../src/lib/tools/chat-writes";
import { ORBIT_TOOLS } from "../src/lib/tools/definitions";
import { isToolError, runTool, toolsFor } from "../src/lib/tools/registry";

const USER = "demo-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function clear() {
  const db = await getDb();
  await db.delete(chatThreads).where(eq(chatThreads.userId, USER));
  await db.delete(actionItems).where(eq(actionItems.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(eventAttendees).where(eq(eventAttendees.userId, USER));
  await db.delete(events).where(eq(events.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(tags).where(eq(tags.userId, USER));
}

async function main() {
  await clear();
  const db = await getDb();

  // --- seed one of everything a write can touch ------------------------------------------
  const [ada] = await db.insert(contacts).values({ userId: USER, fullName: "Ada Lovelace", company: "Analytical Engines", notes: "Met at the Royal Society." }).returning();
  const [stranger] = await db.insert(contacts).values({ userId: USER, fullName: "Not In This Turn" }).returning();
  const [rem] = await db
    .insert(reminders)
    .values({ userId: USER, title: "Send Ada the notes", status: "pending", reminderType: "manual", dueDate: new Date(Date.now() + 2 * 86_400_000) })
    .returning();
  const [note] = await db.insert(interactions).values({ userId: USER, contactId: ada.id, interactionType: "note", rawNotes: "coffee", interactionDate: new Date() }).returning();
  const [item] = await db.insert(actionItems).values({ userId: USER, contactId: ada.id, interactionId: note.id, text: "Send the deck", itemHash: "w1" }).returning();
  const soon = new Date(Date.now() + 5 * 86_400_000);
  const [summit] = await db.insert(events).values({ userId: USER, title: "AWS Summit", startsAt: soon, endsAt: soon }).returning();
  const [att] = await db.insert(eventAttendees).values({ eventId: summit.id, userId: USER, fullName: "Grace Hopper", identityKey: "w-grace" }).returning();
  const [thread] = await db.insert(chatThreads).values({ userId: USER }).returning();

  // --- propose -----------------------------------------------------------------------------
  console.log("Proposing");
  const sink = createProposalSink({
    contacts: new Map([[ada.id, "Ada Lovelace"]]),
    reminders: new Map([[rem.id, "Send Ada the notes"]]),
    events: new Map([[summit.id, "AWS Summit"]]),
    actionItems: new Map([[item.id, "Send the deck"]]),
  });
  const tools = proposerTools(sink);
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name)!;
    return runTool(tool, USER, args, { surface: "chat", scopes: ["read"] });
  };

  const stray = await call("delete_contact", { contactId: stranger.id });
  check("a contact id the turn never saw is refused, with a message the model can read", isToolError(stray) && /not in anything you were shown/.test(stray.error), JSON.stringify(stray));
  check("…and no card is stored", sink.list().length === 0);
  check("an attendee only becomes nameable once a roster lookup returns it", isToolError(await call("mark_spoke_to", { eventId: summit.id, attendeeIds: [att.id] })));
  sink.harvest("get_event_roster", { event: { id: summit.id, title: "AWS Summit" }, people: [{ attendeeId: att.id, name: "Grace Hopper" }] });

  const proposed: Array<[string, Record<string, unknown>]> = [
    ["log_note", { contactId: ada.id, text: "Talked about the difference engine" }],
    ["update_contact", { contactId: ada.id, title: "Mathematician", notes_append: "Prefers email" }],
    ["add_tags", { contactId: ada.id, tags: ["pioneer"] }],
    ["create_reminder", { title: "Book the summit hotel", due_date: new Date(Date.now() + 3 * 86_400_000).toISOString() }],
    ["snooze_reminder", { reminderId: rem.id, days: 7 }],
    ["complete_action_item", { actionItemId: item.id }],
    ["mark_spoke_to", { eventId: summit.id, attendeeIds: [att.id] }],
    ["create_event", { title: "Founders mixer", starts_on: new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10), city: "London" }],
  ];
  for (const [name, args] of proposed) {
    const out = await call(name, args);
    check(`${name}: proposed, said to be awaiting confirmation`, !isToolError(out) && (out as { status: string }).status === "proposed", JSON.stringify(out));
  }
  await call("log_note", { contactId: ada.id, text: "Talked about the difference engine" });
  check("the same change twice is one card", sink.list().length === proposed.length);
  const cards = sink.list();
  check("previews come from the turn's own names", cards[0].preview === "Log a note on Ada Lovelace: “Talked about the difference engine”", cards[0].preview);
  check("…and say what is being changed", /Update Ada Lovelace: title → “Mathematician”, add to notes: “Prefers email”/.test(cards[1].preview), cards[1].preview);
  check("each card carries its tier", cards.find((c) => c.args.tool === "update_contact")?.tier === "confirm" && cards[0].tier === "auto");

  // --- store, commit, undo -------------------------------------------------------------------
  const [message] = await db
    .insert(chatMessages)
    .values({ threadId: thread.id, userId: USER, role: "assistant", content: "Set those up for you to confirm.", proposedActions: cards })
    .returning();
  const byTool = (tool: string) => cards.find((c) => c.args.tool === tool)!;
  const stored = async (id: string) =>
    ((await db.query.chatMessages.findFirst({ where: eq(chatMessages.id, message.id) }))?.proposedActions ?? []).find(
      (a: StoredProposedAction) => a.id === id
    );

  console.log("\nCommitting and undoing");
  {
    const c = byTool("log_note");
    const res = await commitProposedAction(message.id, c.id);
    const row = res.ok && res.resultId ? await db.query.interactions.findFirst({ where: eq(interactions.id, res.resultId) }) : undefined;
    check("log_note: the note is written, as a chat proposal", row?.rawNotes === "Talked about the difference engine" && row.source === "chat_proposed", JSON.stringify(res));
    check("…a second click does nothing", !(await commitProposedAction(message.id, c.id)).ok);
    check("…the card is done, with an undo", (await stored(c.id))?.status === "done" && Boolean((await stored(c.id))?.undo));
    const undone = await undoProposedAction(message.id, c.id);
    const gone = res.ok && res.resultId ? await db.query.interactions.findFirst({ where: eq(interactions.id, res.resultId) }) : undefined;
    check("…undo removes the note", undone.ok && !gone, JSON.stringify(undone));
    check("…and the card says undone, once", (await stored(c.id))?.status === "undone" && !(await undoProposedAction(message.id, c.id)).ok);
  }
  {
    const c = byTool("update_contact");
    await commitProposedAction(message.id, c.id);
    const after = await db.query.contacts.findFirst({ where: eq(contacts.id, ada.id) });
    check(
      "update_contact: the field changes and a dated line is appended — the notes are never replaced",
      after?.title === "Mathematician" && after.notes?.startsWith("Met at the Royal Society.") === true && /\[\d{4}-\d{2}-\d{2}\] Prefers email$/.test(after.notes ?? ""),
      JSON.stringify({ title: after?.title, notes: after?.notes })
    );
    await undoProposedAction(message.id, c.id);
    const back = await db.query.contacts.findFirst({ where: eq(contacts.id, ada.id) });
    check("…undo restores the previous title and notes", (back?.title ?? "") === "" && back?.notes === "Met at the Royal Society.", JSON.stringify({ title: back?.title, notes: back?.notes }));
  }
  {
    const c = byTool("add_tags");
    await commitProposedAction(message.id, c.id);
    const tagNames = async () =>
      (await db.select({ name: tags.name }).from(contactTags).innerJoin(tags, eq(tags.id, contactTags.tagId)).where(eq(contactTags.contactId, ada.id))).map((r) => r.name);
    check("add_tags: the tag is on the contact", (await tagNames()).includes("pioneer"));
    await undoProposedAction(message.id, c.id);
    check("…undo takes it off again", !(await tagNames()).includes("pioneer"));
  }
  {
    const c = byTool("create_reminder");
    const res = await commitProposedAction(message.id, c.id);
    const row = res.ok && res.resultId ? await db.query.reminders.findFirst({ where: eq(reminders.id, res.resultId) }) : undefined;
    check("create_reminder: the reminder exists", row?.title === "Book the summit hotel" && row.status === "pending");
    await undoProposedAction(message.id, c.id);
    const after = row ? await db.query.reminders.findFirst({ where: eq(reminders.id, row.id) }) : undefined;
    check("…undo takes it off the list", after?.status !== "pending", String(after?.status));
  }
  {
    const c = byTool("snooze_reminder");
    const before = rem.dueDate!.getTime();
    await commitProposedAction(message.id, c.id);
    const snoozed = await db.query.reminders.findFirst({ where: eq(reminders.id, rem.id) });
    check("snooze_reminder: due a week from today", (snoozed?.dueDate?.getTime() ?? 0) > Date.now() + 6 * 86_400_000);
    await undoProposedAction(message.id, c.id);
    const back = await db.query.reminders.findFirst({ where: eq(reminders.id, rem.id) });
    check("…undo puts it back", back?.dueDate?.getTime() === before, `${back?.dueDate?.toISOString()} vs ${rem.dueDate!.toISOString()}`);
  }
  {
    const c = byTool("complete_action_item");
    await commitProposedAction(message.id, c.id);
    check("complete_action_item: ticked off", (await db.query.actionItems.findFirst({ where: eq(actionItems.id, item.id) }))?.status === "done");
    await undoProposedAction(message.id, c.id);
    check("…undo reopens it", (await db.query.actionItems.findFirst({ where: eq(actionItems.id, item.id) }))?.status === "open");
  }
  {
    const c = byTool("mark_spoke_to");
    await commitProposedAction(message.id, c.id);
    check("mark_spoke_to: marked", (await db.query.eventAttendees.findFirst({ where: eq(eventAttendees.id, att.id) }))?.spokeTo === 1);
    await undoProposedAction(message.id, c.id);
    check("…undo unmarks", (await db.query.eventAttendees.findFirst({ where: eq(eventAttendees.id, att.id) }))?.spokeTo === 0);
  }
  {
    const c = byTool("create_event");
    const res = await commitProposedAction(message.id, c.id);
    const row = res.ok && res.resultId ? await db.query.events.findFirst({ where: eq(events.id, res.resultId) }) : undefined;
    check("create_event: the event exists, and no link was taken", row?.title === "Founders mixer" && row.city === "London" && !row.url);
    await undoProposedAction(message.id, c.id);
    check("…undo removes it", !(row ? await db.query.events.findFirst({ where: eq(events.id, row.id) }) : undefined));
  }

  console.log("\nThe rest of the catalog");
  {
    const [rem2] = await db
      .insert(reminders)
      .values({ userId: USER, title: "Call Ada", status: "pending", reminderType: "manual", dueDate: new Date(Date.now() + 86_400_000) })
      .returning();
    const [rem3] = await db
      .insert(reminders)
      .values({ userId: USER, title: "Old reminder", status: "pending", reminderType: "manual", dueDate: new Date(Date.now() + 86_400_000) })
      .returning();
    const [doomed] = await db.insert(contacts).values({ userId: USER, fullName: "Leaving Soon" }).returning();
    const [party] = await db.insert(events).values({ userId: USER, title: "Old party", startsAt: soon, endsAt: soon }).returning();
    await updateContactForUser(USER, ada.id, { tagNames: ["alum", "london"] }, { skipRevalidate: true });

    const sink2 = createProposalSink({
      contacts: new Map([[ada.id, "Ada Lovelace"], [doomed.id, "Leaving Soon"]]),
      reminders: new Map([[rem2.id, "Call Ada"], [rem3.id, "Old reminder"]]),
      events: new Map([[party.id, "Old party"]]),
    });
    const tools2 = proposerTools(sink2);
    const later = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    for (const [name, args] of [
      ["remove_tags", { contactId: ada.id, tags: ["alum"] }],
      ["create_contact", { full_name: "Charles Babbage", company: "Difference Engines" }],
      ["complete_reminder", { reminderId: rem2.id }],
      ["reschedule_reminder", { reminderId: rem2.id, due_date: later }],
      ["delete_reminder", { reminderId: rem3.id }],
      ["schedule_follow_up", { contactId: ada.id, days: 14 }],
      ["delete_contact", { contactId: doomed.id }],
      ["delete_event", { eventId: party.id }],
    ] as Array<[string, Record<string, unknown>]>) {
      const out = await runTool(tools2.find((t) => t.name === name)!, USER, args, { surface: "chat", scopes: ["read"] });
      check(`${name}: proposed`, !isToolError(out), JSON.stringify(out));
    }
    const cards2 = sink2.list();
    check("destructive cards are flagged for the UI", cards2.filter((c) => c.destructive).length === 2);
    const [m3] = await db
      .insert(chatMessages)
      .values({ threadId: thread.id, userId: USER, role: "assistant", content: "More changes.", proposedActions: cards2 })
      .returning();
    const card = (tool: string) => cards2.find((c) => c.args.tool === tool)!;
    const tagNames = async () =>
      (await db.select({ name: tags.name }).from(contactTags).innerJoin(tags, eq(tags.id, contactTags.tagId)).where(eq(contactTags.contactId, ada.id))).map((r) => r.name).sort();
    const status = async (id: string) => (await db.query.reminders.findFirst({ where: eq(reminders.id, id) }))?.status;

    await commitProposedAction(m3.id, card("remove_tags").id);
    check("remove_tags: only the named tag comes off", JSON.stringify(await tagNames()) === JSON.stringify(["london"]), JSON.stringify(await tagNames()));
    await undoProposedAction(m3.id, card("remove_tags").id);
    check("…undo puts it back", JSON.stringify(await tagNames()) === JSON.stringify(["alum", "london"]), JSON.stringify(await tagNames()));

    const made = await commitProposedAction(m3.id, card("create_contact").id);
    const charles = made.ok && made.resultId ? await db.query.contacts.findFirst({ where: eq(contacts.id, made.resultId) }) : undefined;
    check("create_contact: added", charles?.fullName === "Charles Babbage" && charles.company === "Difference Engines", JSON.stringify(made));
    await undoProposedAction(m3.id, card("create_contact").id);
    check("…undo removes the contact it made", !(charles ? await db.query.contacts.findFirst({ where: eq(contacts.id, charles.id) }) : undefined));

    await commitProposedAction(m3.id, card("complete_reminder").id);
    check("complete_reminder: no longer pending", (await status(rem2.id)) !== "pending", String(await status(rem2.id)));
    await undoProposedAction(m3.id, card("complete_reminder").id);
    check("…undo reopens it", (await status(rem2.id)) === "pending", String(await status(rem2.id)));

    await commitProposedAction(m3.id, card("reschedule_reminder").id);
    const moved = await db.query.reminders.findFirst({ where: eq(reminders.id, rem2.id) });
    check("reschedule_reminder: due on the chosen day", moved?.dueDate?.toISOString().slice(0, 10) === later, moved?.dueDate?.toISOString());
    await undoProposedAction(m3.id, card("reschedule_reminder").id);
    const unmoved = await db.query.reminders.findFirst({ where: eq(reminders.id, rem2.id) });
    check("…undo puts the old date back", unmoved?.dueDate?.getTime() === rem2.dueDate!.getTime(), unmoved?.dueDate?.toISOString());

    await commitProposedAction(m3.id, card("delete_reminder").id);
    check("delete_reminder: off the list", (await status(rem3.id)) !== "pending", String(await status(rem3.id)));
    await undoProposedAction(m3.id, card("delete_reminder").id);
    check("…undo restores it", (await status(rem3.id)) === "pending", String(await status(rem3.id)));

    const fu = await commitProposedAction(m3.id, card("schedule_follow_up").id);
    check("schedule_follow_up: commits", fu.ok, JSON.stringify(fu));
    check("…and offers no undo", !(await undoProposedAction(m3.id, card("schedule_follow_up").id)).ok);

    const del = await commitProposedAction(m3.id, card("delete_contact").id);
    check("delete_contact: gone", del.ok && !(await db.query.contacts.findFirst({ where: eq(contacts.id, doomed.id) })), JSON.stringify(del));
    check("…and no undo is claimed", !(await undoProposedAction(m3.id, card("delete_contact").id)).ok);
    await commitProposedAction(m3.id, card("delete_event").id);
    check("delete_event: gone", !(await db.query.events.findFirst({ where: eq(events.id, party.id) })));
    check("…the other contacts untouched", Boolean(await db.query.contacts.findFirst({ where: and(eq(contacts.id, ada.id), eq(contacts.userId, USER)) })));
  }

  console.log("\nThe fences");
  {
    // A stored row is data: one edited to name another contact, or with input its write's
    // schema rejects, does not commit.
    const tampered: StoredProposedAction = {
      id: "tampered-1",
      args: { kind: "tool", tool: "delete_contact", input: { contactId: "not-a-uuid" } },
      preview: "Delete someone",
      status: "proposed",
    };
    const unknown: StoredProposedAction = {
      id: "unknown-1",
      args: { kind: "tool", tool: "send_email", input: {} },
      preview: "Send an email",
      status: "proposed",
    };
    const [m2] = await db
      .insert(chatMessages)
      .values({ threadId: thread.id, userId: USER, role: "assistant", content: "x", proposedActions: [tampered, unknown] })
      .returning();
    check("a stored input its write's schema rejects does not commit", !(await commitProposedAction(m2.id, "tampered-1")).ok);
    check("a tool the catalog does not have does not commit", !(await commitProposedAction(m2.id, "unknown-1")).ok);
    check("…and nobody was deleted", Boolean(await db.query.contacts.findFirst({ where: eq(contacts.id, stranger.id) })));

    const many = createProposalSink({ contacts: new Map([[ada.id, "Ada"]]) });
    const manyTools = proposerTools(many);
    const note = manyTools.find((t) => t.name === "log_note")!;
    for (let i = 0; i < MAX_PROPOSALS + 2; i++) await runTool(note, USER, { contactId: ada.id, text: `note ${i}` }, { surface: "chat", scopes: ["read"] });
    check(`at most ${MAX_PROPOSALS} cards an answer`, many.list().length === MAX_PROPOSALS);

    const chatTools = toolsFor(ORBIT_TOOLS, "chat", ["read", "write"]).map((t) => t.name);
    check(
      "no chat write is in the shared tool registry — they reach chat only as proposers",
      CHAT_WRITES.every((w) => !ORBIT_TOOLS.some((t) => t.name === w.name && t.surfaces.includes("chat")))
    );
    check("and the registry still offers chat no write-scoped tool", toolsFor(ORBIT_TOOLS, "chat", ["read", "write"]).every((t) => t.scope === "read"), chatTools.join(", "));
    check("every proposer is read-scoped: running one stores a card, nothing else", manyTools.every((t) => t.scope === "read"));
    check("destructive writes say so and carry no undo", CHAT_WRITES.filter((w) => w.destructive).every((w) => w.tier === "confirm"));
  }

  await clear();
  if (failures) {
    console.error(`\n${failures} chat-writes check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll chat-writes checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
