/**
 * The feature chat writes (`src/lib/tools/chat-writes-features.ts`, plan Phase 2b), end to end:
 * proposed through the proposer tools with only the ids the turn saw, stored on a message,
 * committed by `commitProposedAction`, and undone by `undoProposedAction` — checking the
 * database after each step. Plus the read tools that hand chat the ids these writes name.
 *
 * PGlite, demo mode (no Clerk), no AI key. Run: npx tsx scripts/smoke-chat-writes-features.ts
 */
import "./smoke/_env";
// The server actions resolve the caller through Clerk; without keys that is demo mode's
// `demo-user` — the same arrangement as smoke-chat-writes.
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { chatMessages, chatThreads, contactOpportunities, contacts, recommendations, reminders, userGoals } from "../src/db/schema";
import { commitProposedAction, undoProposedAction } from "../src/actions/chat-actions";
import type { StoredProposedAction } from "../src/lib/chat-proposed-actions";
import { listSchools, setSchools } from "../src/lib/events/target-companies";
import { createProposalSink, proposerTools, type ProposalSink } from "../src/lib/tools/chat-proposals";
import { ORBIT_TOOLS } from "../src/lib/tools/definitions";
import { isToolError, runTool } from "../src/lib/tools/registry";

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
  await db.delete(userGoals).where(eq(userGoals.userId, USER));
  await db.delete(recommendations).where(eq(recommendations.userId, USER));
  await db.delete(contactOpportunities).where(eq(contactOpportunities.userId, USER));
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await setSchools(USER, []);
}

/** Propose `name(args)` through the sink's proposer, as the loop would. */
async function propose(sink: ProposalSink, name: string, args: Record<string, unknown>) {
  const tool = proposerTools(sink).find((t) => t.name === name)!;
  return runTool(tool, USER, args, { surface: "chat", scopes: ["read"] });
}

/** A read tool's result on chat, harvested into `sink` as the loop does. */
async function lookup(sink: ProposalSink, name: string, args: Record<string, unknown> = {}) {
  const tool = ORBIT_TOOLS.find((t) => t.name === name)!;
  const out = await runTool(tool, USER, args, { surface: "chat", scopes: ["read"] });
  if (!isToolError(out)) sink.harvest(name, out);
  return out;
}

/** Store the sink's cards on a fresh assistant message; returns a finder for one card's state. */
async function store(cards: StoredProposedAction[]) {
  const db = await getDb();
  const [thread] = await db.insert(chatThreads).values({ userId: USER }).returning();
  const [message] = await db
    .insert(chatMessages)
    .values({ threadId: thread.id, userId: USER, role: "assistant", content: "x", proposedActions: cards })
    .returning();
  const card = (tool: string) => cards.find((c) => c.args.kind === "tool" && c.args.tool === tool)!;
  return { messageId: message.id, card };
}

async function main() {
  await clear();
  const db = await getDb();

  console.log("Goals and schools");
  {
    const [kept] = await db.insert(userGoals).values({ userId: USER, text: "Raise a seed round", active: 1 }).returning();
    await setSchools(USER, ["MIT"]);
    const sink = createProposalSink({});
    check("a goal id is unknown until get_goals returns it", isToolError(await propose(sink, "remove_goal", { goalId: kept.id })));
    const goals = (await lookup(sink, "get_goals")) as { items?: Array<{ id: string }> };
    check("get_goals hands chat each goal's id", goals.items?.[0]?.id === kept.id, JSON.stringify(goals));
    const mcpGoals = await runTool(ORBIT_TOOLS.find((t) => t.name === "get_goals")!, USER, {}, { surface: "mcp", scopes: ["read"] });
    check("…and MCP's answer is unchanged: texts only", !("items" in (mcpGoals as object)), JSON.stringify(mcpGoals));

    await propose(sink, "add_goal", { text: "Meet three design leads" });
    await propose(sink, "remove_goal", { goalId: kept.id });
    await propose(sink, "set_schools", { schools: ["MIT", "Stanford"] });
    const cards = sink.list();
    check("three cards, previews from names", cards.length === 3 && /Remove the goal “Raise a seed round”/.test(cards[1].preview), cards.map((c) => c.preview).join(" | "));
    const { messageId, card } = await store(cards);

    const added = await commitProposedAction(messageId, card("add_goal").id);
    const row = added.ok && added.resultId ? await db.query.userGoals.findFirst({ where: eq(userGoals.id, added.resultId) }) : undefined;
    check("add_goal: the goal exists", row?.text === "Meet three design leads", JSON.stringify(added));
    await undoProposedAction(messageId, card("add_goal").id);
    check("…undo removes it", !(row ? await db.query.userGoals.findFirst({ where: eq(userGoals.id, row.id) }) : undefined));

    await commitProposedAction(messageId, card("remove_goal").id);
    check("remove_goal: gone", !(await db.query.userGoals.findFirst({ where: eq(userGoals.id, kept.id) })));
    await undoProposedAction(messageId, card("remove_goal").id);
    const back = await db.query.userGoals.findFirst({ where: eq(userGoals.id, kept.id) });
    check("…undo puts it back with its own id and date", back?.text === "Raise a seed round" && back.createdAt.getTime() === kept.createdAt.getTime());

    await commitProposedAction(messageId, card("set_schools").id);
    check("set_schools: the whole list is replaced", JSON.stringify(await listSchools(USER)) === JSON.stringify(["MIT", "Stanford"]));
    await undoProposedAction(messageId, card("set_schools").id);
    check("…undo restores the list before", JSON.stringify(await listSchools(USER)) === JSON.stringify(["MIT"]));
  }

  console.log("\nOpportunities and radar");
  {
    const [ada] = await db.insert(contacts).values({ userId: USER, fullName: "Ada Lovelace" }).returning();
    const [opp] = await db
      .insert(contactOpportunities)
      .values({ userId: USER, contactId: ada.id, kind: "referral", label: "Intro to Babbage", createdBy: "user" })
      .returning();
    const recRow = (bucket: string) => ({
      userId: USER,
      contactId: ada.id,
      kind: "reconnect" as const,
      score: 50,
      bucket: bucket as never,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      inputsHash: `smoke-${bucket}`,
    });
    const [rec] = await db.insert(recommendations).values(recRow("today")).returning();

    const sink = createProposalSink({ contacts: new Map([[ada.id, "Ada Lovelace"]]) });
    check("an opportunity id is unknown until list_opportunities returns it", isToolError(await propose(sink, "set_opportunity_status", { opportunityId: opp.id, status: "landed" })));
    await lookup(sink, "list_opportunities", { contactId: ada.id });
    const cards = (await lookup(sink, "list_radar_cards")) as Array<{ id?: string }>;
    check("list_radar_cards hands chat each card's own id", cards[0]?.id === rec.id, JSON.stringify(cards));

    await propose(sink, "create_opportunity", { contactId: ada.id, kind: "investor", label: "Angel cheque", direction: "they_offer" });
    await propose(sink, "update_opportunity", { opportunityId: opp.id, label: "Intro to Charles Babbage" });
    await propose(sink, "set_opportunity_status", { opportunityId: opp.id, status: "landed" });
    await propose(sink, "delete_opportunity", { opportunityId: opp.id });
    await propose(sink, "snooze_recommendation", { recommendationId: rec.id, length: "1w" });
    await propose(sink, "dismiss_recommendation", { recommendationId: rec.id });
    await propose(sink, "schedule_recommendation", { recommendationId: rec.id, days: 7 });
    const list = sink.list();
    check("seven cards", list.length === 7, list.map((c) => c.preview).join(" | "));
    check("tiers: create and status apply-able, edit/delete/schedule ask", list.map((c) => c.tier).join(",") === "auto,confirm,auto,confirm,auto,confirm,confirm", list.map((c) => c.tier).join(","));
    const { messageId, card } = await store(list);
    const oppNow = async () => db.query.contactOpportunities.findFirst({ where: eq(contactOpportunities.id, opp.id) });

    const made = await commitProposedAction(messageId, card("create_opportunity").id);
    const madeRow = made.ok && made.resultId ? await db.query.contactOpportunities.findFirst({ where: eq(contactOpportunities.id, made.resultId) }) : undefined;
    check("create_opportunity: tracked on Ada", madeRow?.label === "Angel cheque" && madeRow.kind === "investor" && madeRow.direction === "they_offer", JSON.stringify(made));
    await undoProposedAction(messageId, card("create_opportunity").id);
    check("…undo removes it", !(madeRow ? await db.query.contactOpportunities.findFirst({ where: eq(contactOpportunities.id, madeRow.id) }) : undefined));

    await commitProposedAction(messageId, card("update_opportunity").id);
    check("update_opportunity: label changed", (await oppNow())?.label === "Intro to Charles Babbage");
    await undoProposedAction(messageId, card("update_opportunity").id);
    check("…undo restores it", (await oppNow())?.label === "Intro to Babbage");

    await commitProposedAction(messageId, card("set_opportunity_status").id);
    check("set_opportunity_status: landed, with a closed date", (await oppNow())?.status === "landed" && Boolean((await oppNow())?.closedAt));
    await undoProposedAction(messageId, card("set_opportunity_status").id);
    check("…undo reopens it", (await oppNow())?.status === "open" && !(await oppNow())?.closedAt);

    await commitProposedAction(messageId, card("delete_opportunity").id);
    check("delete_opportunity: gone", !(await oppNow()));
    await undoProposedAction(messageId, card("delete_opportunity").id);
    const restored = await db.query.contactOpportunities.findMany({ where: eq(contactOpportunities.contactId, ada.id) });
    check("…undo brings it back (under a new id)", restored.some((o) => o.label === "Intro to Babbage"), JSON.stringify(restored.map((o) => o.label)));

    const recNow = async () => db.query.recommendations.findFirst({ where: eq(recommendations.id, rec.id) });
    await commitProposedAction(messageId, card("snooze_recommendation").id);
    check("snooze_recommendation: snoozed", (await recNow())?.status === "snoozed");
    await undoProposedAction(messageId, card("snooze_recommendation").id);
    check("…undo puts the card back", (await recNow())?.status === "pending");
    await commitProposedAction(messageId, card("dismiss_recommendation").id);
    check("dismiss_recommendation: dismissed", (await recNow())?.status === "dismissed");
    await undoProposedAction(messageId, card("dismiss_recommendation").id);
    check("…undo puts the card back", (await recNow())?.status === "pending");
    const sched = await commitProposedAction(messageId, card("schedule_recommendation").id);
    const followUps = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
    check(
      "schedule_recommendation: accepted, with a follow-up reminder",
      sched.ok && (await recNow())?.status === "accepted" && followUps.some((r) => r.contactId === ada.id && r.status === "pending"),
      JSON.stringify({ sched, status: (await recNow())?.status, reminders: followUps.map((r) => [r.title, r.status]) })
    );
    check("…and offers no undo, since the reminder would stay", !(await undoProposedAction(messageId, card("schedule_recommendation").id)).ok);
  }

  await clear();
  if (failures) {
    console.error(`\n${failures} chat-writes-features check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll chat-writes-features checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
