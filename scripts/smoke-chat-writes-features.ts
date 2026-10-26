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
import { randomUUID } from "node:crypto";
import {
  calendarEvents,
  calendarSources,
  chatMessages,
  chatThreads,
  contactOpportunities,
  contacts,
  interactions,
  meetingSessions,
  outreachCampaigns,
  outreachMessages,
  outreachProspects,
  recommendations,
  recruiters,
  reminders,
  userGoals,
  userRecruiterLinks,
} from "../src/db/schema";
import { commitProposedAction, undoProposedAction } from "../src/actions/chat-actions";
import { getChatSendContext } from "../src/actions/chat-send";
import { loadRadarAutopilot } from "../src/lib/radar/autopilot";
import type { StoredProposedAction } from "../src/lib/chat-proposed-actions";
import { listSchools, setSchools } from "../src/lib/events/target-companies";
import { setSurfaceComingSoon } from "../src/lib/surface-visibility";
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
  await db.delete(outreachCampaigns).where(eq(outreachCampaigns.userId, USER));
  await db.delete(userRecruiterLinks).where(eq(userRecruiterLinks.userId, USER));
  await db.delete(meetingSessions).where(eq(meetingSessions.userId, USER));
  await db.delete(calendarEvents).where(eq(calendarEvents.userId, USER));
  await db.delete(calendarSources).where(eq(calendarSources.userId, USER));
  await db.delete(recruiters).where(eq(recruiters.createdByUserId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
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
  const card = (tool: string) => cards.find((c) => c.args.tool === tool)!;
  return { messageId: message.id, card };
}

/** An id that is no one's: a contact the draft card never names. */
const ada_id = () => "00000000-0000-4000-8000-000000000000";

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
    await setSurfaceComingSoon("smoke-chat-writes-features", "page.radar", true);
    const early = await commitProposedAction(messageId, card("snooze_recommendation").id);
    check("while radar is coming soon, its cards cannot be acted on from chat", !early.ok && (await recNow())?.status === "pending", JSON.stringify(early));
    await setSurfaceComingSoon("smoke-chat-writes-features", "page.radar", false);
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
    await setSurfaceComingSoon("smoke-chat-writes-features", "page.radar", true);
  }

  console.log("\nOutreach — wording, drafts and outcomes, never a send");
  {
    const [grace] = await db.insert(contacts).values({ userId: USER, fullName: "Grace Hopper" }).returning();
    const [campaign] = await db
      .insert(outreachCampaigns)
      .values({ userId: USER, name: "Compiler founders", tone: "warm", messageIntent: "Ask for 20 minutes" })
      .returning();
    const [prospect] = await db
      .insert(outreachProspects)
      .values({ campaignId: campaign.id, externalId: "smoke-grace", fullName: "Grace Hopper", contactId: grace.id })
      .returning();
    const [draft] = await db
      .insert(outreachMessages)
      .values({ prospectId: prospect.id, channel: "email", subject: "Hello", body: "Hi Grace — first draft", status: "draft" })
      .returning();
    const [sent] = await db
      .insert(outreachMessages)
      .values({ prospectId: prospect.id, channel: "email", subject: "Earlier", body: "Sent already", status: "sent", stepIndex: 1 })
      .returning();
    const [followUp] = await db
      .insert(outreachMessages)
      .values({ prospectId: prospect.id, channel: "email", body: "Bumping this", status: "scheduled", stepIndex: 2 })
      .returning();

    const sink = createProposalSink({});
    await lookup(sink, "list_campaigns");
    const msgs = (await lookup(sink, "list_outreach_messages", { campaignId: campaign.id })) as { messages?: Array<{ messageId: string; prospect: string }> };
    check("list_outreach_messages hands chat each message's id and prospect", msgs.messages?.length === 3 && msgs.messages.every((m) => m.prospect === "Grace Hopper"), JSON.stringify(msgs).slice(0, 200));

    await propose(sink, "update_campaign", { campaignId: campaign.id, tone: "direct" });
    await propose(sink, "update_outreach_draft", { messageId: draft.id, body: "Hi Grace — shorter draft" });
    await propose(sink, "update_outreach_draft", { messageId: sent.id, body: "Rewriting history" });
    await propose(sink, "log_outreach_outcome", { messageId: sent.id, outcome: "positive_reply", notes: "Keen to chat" });
    const list = sink.list();
    check("four cards, all of which ask", list.length === 4 && list.every((c) => c.tier === "confirm"), list.map((c) => `${c.tier}:${c.preview}`).join(" | "));
    check(
      "no chat write can send, activate a campaign or search for prospects",
      !proposerTools(sink).some((tool) => /send|activate|prospect/.test(tool.name) && tool.name !== "draft_email"),
      proposerTools(sink).map((tool) => tool.name).join(", ")
    );
    const { messageId, card } = await store(list);

    // Outreach ships coming soon: its writes refuse, exactly as the page's own actions do.
    await setSurfaceComingSoon("smoke-chat-writes-features", "page.outreach", true);
    const closed = await commitProposedAction(messageId, card("update_campaign").id);
    check("while outreach is coming soon, its writes refuse", !closed.ok && (await db.query.outreachCampaigns.findFirst({ where: eq(outreachCampaigns.id, campaign.id) }))?.tone === "warm", JSON.stringify(closed));
    await setSurfaceComingSoon("smoke-chat-writes-features", "page.outreach", false);
    const draftCards = list.filter((c) => c.args.tool === "update_outreach_draft");

    const camp = async () => db.query.outreachCampaigns.findFirst({ where: eq(outreachCampaigns.id, campaign.id) });
    const res = await commitProposedAction(messageId, card("update_campaign").id);
    check("update_campaign: the tone changes, nothing else", res.ok && (await camp())?.tone === "direct" && (await camp())?.status === "draft", JSON.stringify(res));
    await undoProposedAction(messageId, card("update_campaign").id);
    check("…undo restores it", (await camp())?.tone === "warm");

    const msg = async (id: string) => db.query.outreachMessages.findFirst({ where: eq(outreachMessages.id, id) });
    await commitProposedAction(messageId, draftCards[0].id);
    check("update_outreach_draft: an unsent draft is rewritten", (await msg(draft.id))?.body === "Hi Grace — shorter draft");
    await undoProposedAction(messageId, draftCards[0].id);
    check("…undo restores the text", (await msg(draft.id))?.body === "Hi Grace — first draft");
    const refused = await commitProposedAction(messageId, draftCards[1].id);
    check("…a message that has gone out is not rewritten", !refused.ok && (await msg(sent.id))?.body === "Sent already", JSON.stringify(refused));

    const out = await commitProposedAction(messageId, card("log_outreach_outcome").id);
    const p = await db.query.outreachProspects.findFirst({ where: eq(outreachProspects.id, prospect.id) });
    const logged = await db.query.interactions.findMany({ where: eq(interactions.contactId, grace.id) });
    check(
      "log_outreach_outcome: outcome on the message, prospect interested, follow-up skipped, interaction on Grace",
      out.ok && (await msg(sent.id))?.outcome === "positive_reply" && p?.status === "interested" && (await msg(followUp.id))?.status === "skipped" && logged.length === 1,
      JSON.stringify({ out, prospect: p?.status, followUp: (await msg(followUp.id))?.status, logged: logged.length })
    );
    // Back to the default, so a later script in this PGlite does not inherit the release.
    await setSurfaceComingSoon("smoke-chat-writes-features", "page.outreach", true);
  }

  console.log("\nRecruiters");
  {
    const sink = createProposalSink({});
    await propose(sink, "log_recruiter", { full_name: "Joan Clarke", firm: "Bletchley Talent", status: "contacted", notes: "Met at the meetup" });
    const logCard = sink.list()[0];
    check("log_recruiter asks, and says the directory entry is shared", logCard?.tier === "confirm" && /shared directory entry/.test(logCard.preview), logCard?.preview);
    const { messageId: m1, card: c1 } = await store(sink.list());
    const logged = await commitProposedAction(m1, c1("log_recruiter").id);
    const link = async (rid: string) =>
      db.query.userRecruiterLinks.findFirst({ where: (l, { and: both, eq: is }) => both(is(l.userId, USER), is(l.recruiterId, rid)) });
    const rid = logged.ok ? logged.resultId! : "";
    check("…logged: a shared row and the user's own link, from chat", logged.ok && (await link(rid))?.status === "contacted" && (await link(rid))?.source === "chat", JSON.stringify(logged));

    // A later turn: the recruiter is named by the id list_my_recruiters returns.
    const later = createProposalSink({});
    await lookup(later, "list_my_recruiters");
    await propose(later, "update_recruiter_link", { recruiterId: rid, status: "active", personal_rating: 4 });
    await propose(later, "update_recruiter_link", { recruiterId: rid, notes: "Prefers mornings" });
    const [statusCard, notesCard] = later.list();
    check("a status or rating change can apply itself; notes ask", statusCard?.tier === "auto" && notesCard?.tier === "confirm", later.list().map((c) => c.tier).join(","));
    const { messageId: m2 } = await store(later.list());
    await commitProposedAction(m2, statusCard.id);
    check("update_recruiter_link: status and rating on the user's own link", (await link(rid))?.status === "active" && (await link(rid))?.personalRating === 4);
    await undoProposedAction(m2, statusCard.id);
    check("…undo restores them", (await link(rid))?.status === "contacted" && (await link(rid))?.personalRating === null);
    await commitProposedAction(m2, notesCard.id);
    check("notes change", (await link(rid))?.notes === "Prefers mornings");
    await undoProposedAction(m2, notesCard.id);
    check("…undo restores the old notes", (await link(rid))?.notes === "Met at the meetup");

    await undoProposedAction(m1, c1("log_recruiter").id);
    check("undoing the log removes the user's link, and leaves the shared row", !(await link(rid)) && Boolean(await db.query.recruiters.findFirst({ where: eq(recruiters.id, rid) })));
  }

  console.log("\nMeetings");
  {
    const [meeting] = await db.insert(meetingSessions).values({ userId: USER, title: "Untitled recording", status: "saved" }).returning();
    const [doomed] = await db.insert(meetingSessions).values({ userId: USER, title: "Test recording", status: "saved" }).returning();
    const [source] = await db
      .insert(calendarSources)
      .values({ userId: USER, provider: "google", connectionId: randomUUID(), calendarId: "primary" })
      .returning();
    const start = new Date(Date.now() + 3_600_000);
    const [event] = await db
      .insert(calendarEvents)
      .values({ userId: USER, sourceId: source.id, providerEventId: "smoke-weekly-1on1", seriesId: "smoke-series", title: "Weekly 1:1", startAt: start, endAt: new Date(start.getTime() + 1_800_000) })
      .returning();

    const sink = createProposalSink({});
    sink.harvest("search_meetings", [{ meetingId: meeting.id, title: "Untitled recording" }, { meetingId: doomed.id, title: "Test recording" }]);
    const upcoming = (await lookup(sink, "upcoming_meetings")) as Array<{ eventId: string }>;
    check("upcoming_meetings hands chat calendar event ids", Array.isArray(upcoming) && upcoming.some((e) => e.eventId === event.id), JSON.stringify(upcoming).slice(0, 200));
    await propose(sink, "rename_meeting", { meetingId: meeting.id, title: "Weekly 1:1 with Sam" });
    await propose(sink, "link_meeting_to_event", { meetingId: meeting.id, calendarEventId: event.id });
    await propose(sink, "discard_meeting", { meetingId: doomed.id });
    const list = sink.list();
    check("three cards; discarding is destructive and asks", list.length === 3 && list[2].destructive === true && list[2].tier === "confirm", list.map((c) => c.preview).join(" | "));
    const { messageId, card } = await store(list);
    const now = async (id: string) => db.query.meetingSessions.findFirst({ where: eq(meetingSessions.id, id) });

    await commitProposedAction(messageId, card("rename_meeting").id);
    check("rename_meeting: retitled", (await now(meeting.id))?.title === "Weekly 1:1 with Sam");
    await undoProposedAction(messageId, card("rename_meeting").id);
    check("…undo restores the old title", (await now(meeting.id))?.title === "Untitled recording");

    await commitProposedAction(messageId, card("link_meeting_to_event").id);
    check("link_meeting_to_event: linked by the provider's event and series ids", (await now(meeting.id))?.calendarEventKey === "smoke-weekly-1on1" && (await now(meeting.id))?.calendarSeriesId === "smoke-series");
    await undoProposedAction(messageId, card("link_meeting_to_event").id);
    check("…undo clears the link it made", (await now(meeting.id))?.calendarEventKey === null);

    const gone = await commitProposedAction(messageId, card("discard_meeting").id);
    check("discard_meeting: the recording is gone, with no undo", gone.ok && !(await now(doomed.id)) && !(await undoProposedAction(messageId, card("discard_meeting").id)).ok);
  }

  console.log("\nAn email draft, and radar autopilot");
  {
    const [sam] = await db.insert(contacts).values({ userId: USER, fullName: "Sam Altman", email: "sam@example.com" }).returning();
    const sink = createProposalSink({ contacts: new Map([[sam.id, "Sam Altman"]]) });
    await propose(sink, "draft_email", { contactId: sam.id, body: "Hi Sam — great to meet you at the mixer." });
    await propose(sink, "set_radar_autopilot", { kind: "follow_up", on: true });
    const list = sink.list();
    check("two cards, both asking; the draft says the user sends it", list.every((c) => c.tier === "confirm") && /you review and send it/.test(list[0].preview), list.map((c) => c.preview).join(" | "));
    check("there is no write for the user's writing instructions", !proposerTools(sink).some((tool) => tool.name === "set_writing_instructions"));
    const { messageId, card } = await store(list);

    const ctx = await getChatSendContext(messageId, sam.id);
    check("the send dialog opens for the person a draft card names (not only a recommended one)", ctx?.to === "sam@example.com", JSON.stringify(ctx));
    check("…and for no one else on that message", (await getChatSendContext(messageId, ada_id())) === null);
    // Counted before and after: other smokes sharing this database leave sends on the demo user.
    const sendCount = async () => (await db.query.emailSends.findMany({ where: (r, { eq: is }) => is(r.userId, USER) })).length;
    const sendsBefore = await sendCount();
    const draftDone = await commitProposedAction(messageId, card("draft_email").id);
    const sendsAfter = await sendCount();
    check("draft_email: marking the card done sends nothing", draftDone.ok && sendsAfter === sendsBefore, JSON.stringify({ draftDone, sendsBefore, sendsAfter }));

    await setSurfaceComingSoon("smoke-chat-writes-features", "page.radar", true);
    const closed = await commitProposedAction(messageId, card("set_radar_autopilot").id);
    check("while radar is coming soon, its autopilot cannot be switched from chat", !closed.ok && (await loadRadarAutopilot(USER)).follow_up !== true, JSON.stringify(closed));
    await setSurfaceComingSoon("smoke-chat-writes-features", "page.radar", false);
    await commitProposedAction(messageId, card("set_radar_autopilot").id);
    check("set_radar_autopilot: on for follow-up cards", (await loadRadarAutopilot(USER)).follow_up === true);
    await undoProposedAction(messageId, card("set_radar_autopilot").id);
    check("…undo turns it back off", (await loadRadarAutopilot(USER)).follow_up === false);
    await setSurfaceComingSoon("smoke-chat-writes-features", "page.radar", true);
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
