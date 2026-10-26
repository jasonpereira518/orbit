/**
 * Tenant isolation through the two surfaces an outside program drives: the tool registry
 * (MCP, and Orbit's chat) and the v1 REST API.
 *
 * Every id a tool accepts arrives from a model — on MCP, a model somebody else wrote, holding
 * a valid key for ITS user. An id is a uuid, so it is unguessable in practice but not secret:
 * it travels in URLs, webhook payloads, exports and screenshots. So the property pinned here
 * is not "nobody will try" but "trying does nothing": for every tool that takes an id, user A
 * passing user B's contact / reminder / draft / event id is refused (or answers empty), and
 * B's rows read back byte-identical afterwards — compared both by per-table row counts
 * (`rowCountsFor`) and by re-reading the actual rows.
 *
 * Each refusal is paired with a positive control on A's OWN record, so a refusal cannot pass
 * because the tool is simply broken. A meta-check fails when a tool gains an id-shaped
 * argument this script does not exercise, so the next tool cannot slip past.
 *
 * Then the v1 API's one hard delete: `DELETE /api/v1/webhook-endpoints/:id` with A's valid
 * key against B's endpoint must 404 and leave it in place. (PATCH /v1/followups/:id is
 * covered elsewhere.)
 *
 * Run: npx tsx scripts/smoke-tenant-isolation.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  agentSendRequests,
  calendarEvents,
  calendarSources,
  contactOpportunities,
  contactTags,
  contacts,
  emailSends,
  outreachCampaigns,
  eventAttendees,
  events,
  interactions,
  memoryChunks,
  recommendations,
  recruiters,
  reminders,
  userRecruiterLinks,
  webhookEndpoints,
} from "../src/db/schema";
import { setSurfaceComingSoon } from "../src/lib/surface-visibility";
import { ORBIT_TOOLS } from "../src/lib/tools/definitions";
import { isToolError, runTool, type ToolSurface } from "../src/lib/tools/registry";
import { createAgentSendRequest } from "../src/lib/agent-sends";
import { generateApiKey } from "../src/lib/api/keys";
import { DELETE as endpointDelete } from "../src/app/api/v1/webhook-endpoints/[id]/route";
import { GET as endpointsGet } from "../src/app/api/v1/webhook-endpoints/route";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, insertInteraction, insertReminder, purgeUsers, rowCountsFor } from "./smoke/factories";

const VICTIM = fakeUserId("xt_victim");
const ATTACKER = fakeUserId("xt_attacker");
const SECRET_WORD = "zebracornium";

const tool = (name: string) => {
  const found = ORBIT_TOOLS.find((x) => x.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
};

/** A as the caller, every scope, on the tool's own surface (MCP when it has it). */
async function call(name: string, args: Record<string, unknown>, userId = ATTACKER): Promise<unknown> {
  const t = tool(name);
  const surface: ToolSurface = t.surfaces.includes("mcp") ? "mcp" : "chat";
  return runTool(t, userId, args, { surface, scopes: surface === "mcp" ? ["read", "write"] : undefined });
}

const errorOf = (r: unknown) => (isToolError(r) ? r.error : null);
const mentions = (r: unknown, ...needles: string[]) => {
  const s = JSON.stringify(r ?? null);
  return needles.filter((n) => s.includes(n));
};

run(async () => {
  const t = checker();
  const db = await getDb();
  await purgeUsers(db, [VICTIM, ATTACKER]);

  try {
    // --- Fixtures -------------------------------------------------------------------------------
    const vContact = await insertContact(db, VICTIM, 1, { notes: `VICTIM-PROFILE-NOTE ${SECRET_WORD}` });
    const vInteraction = await insertInteraction(db, VICTIM, vContact.id, { rawNotes: `VICTIM-INTERACTION ${SECRET_WORD}` });
    const vReminder = await insertReminder(db, VICTIM, vContact.id, {
      title: "VICTIM-REMINDER",
      dueDate: new Date(Date.now() - 86_400_000),
    });
    const vDraft = await createAgentSendRequest(VICTIM, {
      toEmail: "victim-friend@example.com",
      subject: "VICTIM-DRAFT-SUBJECT",
      body: "VICTIM-DRAFT-BODY",
      contactId: vContact.id,
    });
    const [vSource] = await db
      .insert(calendarSources)
      .values({ userId: VICTIM, provider: "google", connectionId: randomUUID(), calendarId: "primary" })
      .returning();
    const vStart = new Date(Date.now() + 3_600_000);
    const [vEvent] = await db
      .insert(calendarEvents)
      .values({
        userId: VICTIM,
        sourceId: vSource.id,
        providerEventId: "xt-victim-event",
        title: "VICTIM-MEETING",
        startAt: vStart,
        endAt: new Date(vStart.getTime() + 1_800_000),
        attendees: [{ name: vContact.fullName, email: vContact.email ?? "", contactId: vContact.id }],
        attendeeCount: 1,
      })
      .returning();
    await db.insert(memoryChunks).values({
      userId: VICTIM,
      sourceKind: "interaction",
      sourceId: vInteraction.id,
      contactId: vContact.id,
      contactIds: [vContact.id],
      occurredAt: new Date(),
      content: `VICTIM-PASSAGE about the ${SECRET_WORD} merger`,
      contentHash: "xt-victim",
    });

    const aContact = await insertContact(db, ATTACKER, 2);
    const aInteraction = await insertInteraction(db, ATTACKER, aContact.id, { rawNotes: `attacker's own ${SECRET_WORD} note` });
    await db.insert(memoryChunks).values({
      userId: ATTACKER,
      sourceKind: "interaction",
      sourceId: aInteraction.id,
      contactId: aContact.id,
      contactIds: [aContact.id],
      occurredAt: new Date(),
      content: `ATTACKER-PASSAGE about the ${SECRET_WORD} merger`,
      contentHash: "xt-attacker",
    });
    const aReminder = await insertReminder(db, ATTACKER, aContact.id, { title: "ATTACKER-REMINDER", dueDate: new Date(Date.now() - 86_400_000) });
    const aReminder2 = await insertReminder(db, ATTACKER, aContact.id, { title: "ATTACKER-REMINDER-2" });

    // Orbit events, opportunities and sent email, one of each per account, for the chat tools
    // that read them by id (src/lib/tools/definitions-features.ts).
    const soon = new Date(Date.now() + 5 * 86_400_000);
    const sendRow = (userId: string, contactId: string, subject: string) => ({
      userId,
      provider: "gmail",
      fromEmail: "me@example.com",
      to: ["x@example.com"],
      subject,
      bodyText: `${subject} body`,
      contactIds: [contactId],
      origin: "compose",
      sendAt: new Date(),
      status: "sent",
      rfcMessageId: `<${randomUUID()}@orbit>`,
    });
    const [vOrbitEvent] = await db.insert(events).values({ userId: VICTIM, title: "VICTIM-EVENT", startsAt: soon, endsAt: soon }).returning();
    const [vAttendee] = await db.insert(eventAttendees).values({ eventId: vOrbitEvent.id, userId: VICTIM, fullName: "VICTIM-ATTENDEE", contactId: vContact.id, identityKey: `xt-v-${randomUUID()}` }).returning();
    const [vOpportunity] = await db.insert(contactOpportunities).values({ userId: VICTIM, contactId: vContact.id, kind: "referral", label: "VICTIM-OPPORTUNITY" } as never).returning();
    const [vCampaign] = await db.insert(outreachCampaigns).values({ userId: VICTIM, name: "VICTIM-CAMPAIGN" }).returning();
    const [aCampaign] = await db.insert(outreachCampaigns).values({ userId: ATTACKER, name: "ATTACKER-CAMPAIGN" }).returning();
    await db.insert(emailSends).values(sendRow(VICTIM, vContact.id, "VICTIM-EMAIL") as never);
    const [aOrbitEvent] = await db.insert(events).values({ userId: ATTACKER, title: "ATTACKER-EVENT", startsAt: soon, endsAt: soon }).returning();
    const [aAttendee] = await db.insert(eventAttendees).values({ eventId: aOrbitEvent.id, userId: ATTACKER, fullName: "ATTACKER-ATTENDEE", contactId: aContact.id, identityKey: `xt-a-${randomUUID()}` }).returning();
    const [aOpportunity] = await db.insert(contactOpportunities).values({ userId: ATTACKER, contactId: aContact.id, kind: "referral", label: "ATTACKER-OPPORTUNITY" } as never).returning();
    const recRow = (userId: string, contactId: string) => ({
      userId,
      contactId,
      kind: "reconnect" as const,
      score: 50,
      bucket: "today" as never,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      inputsHash: `xt-${userId}`,
    });
    const [vRecommendation] = await db.insert(recommendations).values(recRow(VICTIM, vContact.id)).returning();
    const [aRecommendation] = await db.insert(recommendations).values(recRow(ATTACKER, aContact.id)).returning();
    // Recruiters are shared rows; what is the user's own is their link to one.
    const [vRecruiter] = await db.insert(recruiters).values({ fullName: "VICTIM-RECRUITER", nameNormalized: "victim-recruiter", createdByUserId: VICTIM }).returning();
    const [aRecruiter] = await db.insert(recruiters).values({ fullName: "ATTACKER-RECRUITER", nameNormalized: "attacker-recruiter", createdByUserId: ATTACKER }).returning();
    await db.insert(userRecruiterLinks).values({ userId: VICTIM, recruiterId: vRecruiter.id, status: "active", notes: "VICTIM-NOTES" });
    await db.insert(userRecruiterLinks).values({ userId: ATTACKER, recruiterId: aRecruiter.id });
    await db.insert(emailSends).values(sendRow(ATTACKER, aContact.id, "ATTACKER-EMAIL") as never);

    /** Everything B owns that a tool could touch, read back in full. */
    const victimState = async () => {
      const [c, i, r, d, e, m] = await Promise.all([
        db.select().from(contacts).where(eq(contacts.userId, VICTIM)),
        db.select().from(interactions).where(eq(interactions.userId, VICTIM)),
        db.select().from(reminders).where(eq(reminders.userId, VICTIM)),
        db.select().from(agentSendRequests).where(eq(agentSendRequests.userId, VICTIM)),
        db.select().from(calendarEvents).where(eq(calendarEvents.userId, VICTIM)),
        db.select().from(memoryChunks).where(eq(memoryChunks.userId, VICTIM)),
      ]);
      return JSON.stringify({ c, i, r, d, e, m });
    };
    const victimBefore = await victimState();
    const victimCountsBefore = await rowCountsFor(db, VICTIM);

    // --- Tools ---------------------------------------------------------------------------------
    console.log("Tools refuse another account's ids…");
    const exercised = new Set<string>();
    const refused = (name: string, r: unknown, needle = "No such") => {
      exercised.add(name);
      const e = errorOf(r);
      t.check(`${name}: B's id is refused`, e !== null && e.includes(needle), JSON.stringify(r).slice(0, 160));
    };
    const control = (name: string, r: unknown, ok: (r: unknown) => boolean) =>
      t.check(`${name}: control — A's own id works`, !isToolError(r) && ok(r), JSON.stringify(r).slice(0, 160));

    // Reads by id.
    refused("get_contact", await call("get_contact", { contactId: vContact.id }));
    control("get_contact", await call("get_contact", { contactId: aContact.id }), (r) => (r as { id: string }).id === aContact.id);
    refused("get_timeline", await call("get_timeline", { contactId: vContact.id }));
    control("get_timeline", await call("get_timeline", { contactId: aContact.id }), (r) => (r as { total: number }).total >= 1);
    refused("get_send_status", await call("get_send_status", { draftId: vDraft.id }));
    refused("meeting_context", await call("meeting_context", { eventId: vEvent.id }), "No matching meeting");
    refused("get_event_roster", await call("get_event_roster", { eventId: vOrbitEvent.id }), "No event");
    control("get_event_roster", await call("get_event_roster", { eventId: aOrbitEvent.id }), (r) => (r as { total: number }).total === 1);
    refused("who_to_talk_to", await call("who_to_talk_to", { eventId: vOrbitEvent.id }), "No event");
    control("who_to_talk_to", await call("who_to_talk_to", { eventId: aOrbitEvent.id }), (r) => (r as { event: { id: string } }).event.id === aOrbitEvent.id);
    refused("get_dossier", await call("get_dossier", { contactId: vContact.id }), "No contact");
    refused("list_outreach_messages", await call("list_outreach_messages", { campaignId: vCampaign.id }), "No campaign");
    control("list_outreach_messages", await call("list_outreach_messages", { campaignId: aCampaign.id }), (r) => (r as { campaign: { id: string } }).campaign.id === aCampaign.id);
    control("get_dossier", await call("get_dossier", { contactId: aContact.id }), (r) => (r as { contact: { id: string } }).contact.id === aContact.id);

    // Reads filtered by an id: no refusal, but nothing of B's may come back.
    const leakFree = async (name: string, args: Record<string, unknown>, ownArgs: Record<string, unknown>, ownNeedle: string) => {
      exercised.add(name);
      const r = await call(name, args);
      const leaked = mentions(r, "VICTIM-", vContact.id, vReminder.id, vEvent.id, vInteraction.id);
      t.check(`${name}: filtering by B's id returns nothing of B's`, !isToolError(r) && leaked.length === 0, leaked.join(", ") || JSON.stringify(r).slice(0, 120));
      const own = await call(name, ownArgs);
      t.check(`${name}: control — filtering by A's own id finds A's row`, mentions(own, ownNeedle).length > 0, JSON.stringify(own).slice(0, 160));
    };
    await leakFree("list_reminders", { view: "today", contactId: vContact.id }, { view: "today", contactId: aContact.id }, "ATTACKER-REMINDER");
    await leakFree("list_open_commitments", { contactId: vContact.id }, { contactId: aContact.id }, "ATTACKER-REMINDER");
    await leakFree("search_notes", { query: SECRET_WORD, contactId: vContact.id }, { query: SECRET_WORD, contactId: aContact.id }, "ATTACKER-PASSAGE");
    await leakFree("query_interactions", { contactId: vContact.id }, { contactId: aContact.id }, aInteraction.id);
    await leakFree("events_with_contact", { contactId: vContact.id }, { contactId: aContact.id }, "ATTACKER-EVENT");
    await leakFree("list_opportunities", { contactId: vContact.id }, { contactId: aContact.id }, "ATTACKER-OPPORTUNITY");
    await leakFree("list_sent_emails", { contactId: vContact.id }, { contactId: aContact.id }, "ATTACKER-EMAIL");
    {
      exercised.add("upcoming_meetings");
      const r = await call("upcoming_meetings", { contactId: vContact.id });
      t.check("upcoming_meetings: filtering by B's contact returns none of B's events", Array.isArray(r) && r.length === 0, JSON.stringify(r).slice(0, 160));
      const own = await call("upcoming_meetings", { contactId: vContact.id }, VICTIM);
      t.check("upcoming_meetings: control — B sees the event on B's own key", mentions(own, "VICTIM-MEETING").length > 0, JSON.stringify(own).slice(0, 160));
    }

    // Writes by id.
    refused("update_contact", await call("update_contact", { contactId: vContact.id, company: "Pwned Inc", notes: "overwritten" }));
    control("update_contact", await call("update_contact", { contactId: aContact.id, company: "Attacker Co" }), (r) => (r as { updated: boolean }).updated);
    refused("add_note", await call("add_note", { contactId: vContact.id, note: "planted note" }));
    control("add_note", await call("add_note", { contactId: aContact.id, note: "own note", externalId: "xt-own-note" }), (r) => (r as { added: boolean }).added);
    refused("log_interaction", await call("log_interaction", { contactId: vContact.id, notes: "planted interaction" }));
    control("log_interaction", await call("log_interaction", { contactId: aContact.id, notes: "own call", externalId: "xt-own-call" }), (r) => (r as { logged: boolean }).logged);
    refused("create_reminder", await call("create_reminder", { title: "planted reminder", contactId: vContact.id }));
    control("create_reminder", await call("create_reminder", { title: "own reminder", contactId: aContact.id }), (r) => (r as { created: boolean }).created);
    refused("complete_reminder", await call("complete_reminder", { reminderId: vReminder.id }));
    control("complete_reminder", await call("complete_reminder", { reminderId: aReminder.id }), (r) => (r as { completed: boolean }).completed);
    refused("snooze_reminder", await call("snooze_reminder", { reminderId: vReminder.id, days: 30 }));
    control("snooze_reminder", await call("snooze_reminder", { reminderId: aReminder2.id, days: 3 }), (r) => (r as { snoozed: boolean }).snoozed);
    refused("schedule_follow_up", await call("schedule_follow_up", { contactId: vContact.id, days: 3 }));
    control("schedule_follow_up", await call("schedule_follow_up", { contactId: aContact.id, days: 3 }), (r) => (r as { scheduled: boolean }).scheduled);

    // The catalog writes MCP gained in Phase 4 (`MCP_CHAT_WRITE_TOOLS`).
    refused("add_tags", await call("add_tags", { contactId: vContact.id, tags: ["pwned"] }), "gone");
    control("add_tags", await call("add_tags", { contactId: aContact.id, tags: ["own-tag"] }), (r) => (r as { done: boolean }).done);
    refused("reschedule_reminder", await call("reschedule_reminder", { reminderId: vReminder.id, due_date: "2026-12-01" }), "gone");
    refused("mark_spoke_to", await call("mark_spoke_to", { eventId: vOrbitEvent.id, attendeeIds: [vAttendee.id] }), "gone");
    // A's event, B's attendee: the event check passes, and the write still touches only A's rows.
    await call("mark_spoke_to", { eventId: aOrbitEvent.id, attendeeIds: [vAttendee.id] });
    t.check(
      "mark_spoke_to: B's attendee stays unmarked whichever event is named",
      (await db.query.eventAttendees.findFirst({ where: eq(eventAttendees.id, vAttendee.id) }))?.spokeTo === 0
    );
    control("mark_spoke_to", await call("mark_spoke_to", { eventId: aOrbitEvent.id, attendeeIds: [aAttendee.id] }), (r) => (r as { done: boolean }).done);
    t.check(
      "add_tags: B's contact carries no tag A tried to add",
      (await db.select().from(contactTags).where(eq(contactTags.contactId, vContact.id))).length === 0
    );

    // …and the Phase 2b writes it gained after. Each commit refuses B's id on its own, since MCP
    // has no proposal scope. Outreach and recruiters are paid features and radar and outreach
    // can ship closed, so A is comped and the two pages released for this block only.
    await db.execute(sql`
      INSERT INTO user_settings (user_id, comped_plan, comped_at) VALUES (${ATTACKER}, 'max', now())
      ON CONFLICT (user_id) DO UPDATE SET comped_plan = 'max', comped_at = now()
    `);
    await setSurfaceComingSoon("smoke-tenant-isolation", "page.radar", false);
    await setSurfaceComingSoon("smoke-tenant-isolation", "page.outreach", false);
    try {
      refused("create_opportunity", await call("create_opportunity", { contactId: vContact.id, kind: "referral", label: "planted" }), "Contact not found");
      control("create_opportunity", await call("create_opportunity", { contactId: aContact.id, kind: "referral", label: "own" }), (r) => (r as { done: boolean }).done);
      refused("update_opportunity", await call("update_opportunity", { opportunityId: vOpportunity.id, label: "pwned" }), "gone");
      control("update_opportunity", await call("update_opportunity", { opportunityId: aOpportunity.id, label: "ATTACKER-OPPORTUNITY 2" }), (r) => (r as { done: boolean }).done);
      refused("set_opportunity_status", await call("set_opportunity_status", { opportunityId: vOpportunity.id, status: "dismissed" }), "gone");
      control("set_opportunity_status", await call("set_opportunity_status", { opportunityId: aOpportunity.id, status: "landed" }), (r) => (r as { done: boolean }).done);
      refused("snooze_recommendation", await call("snooze_recommendation", { recommendationId: vRecommendation.id, length: "1w" }), "moved on");
      control("snooze_recommendation", await call("snooze_recommendation", { recommendationId: aRecommendation.id, length: "1w" }), (r) => (r as { done: boolean }).done);
      refused("schedule_recommendation", await call("schedule_recommendation", { recommendationId: vRecommendation.id, days: 7 }), "moved on");
      refused("update_campaign", await call("update_campaign", { campaignId: vCampaign.id, name: "pwned" }), "gone");
      control("update_campaign", await call("update_campaign", { campaignId: aCampaign.id, tone: "direct" }), (r) => (r as { done: boolean }).done);
      refused("update_recruiter_link", await call("update_recruiter_link", { recruiterId: vRecruiter.id, notes: "pwned" }), "haven’t logged");
      control("update_recruiter_link", await call("update_recruiter_link", { recruiterId: aRecruiter.id, status: "contacted" }), (r) => (r as { done: boolean }).done);
      t.check(
        "update_recruiter_link: MCP cannot archive, even on A's own link",
        isToolError(await call("update_recruiter_link", { recruiterId: aRecruiter.id, status: "archived" }))
      );
    } finally {
      await setSurfaceComingSoon("smoke-tenant-isolation", "page.radar", true);
      await setSurfaceComingSoon("smoke-tenant-isolation", "page.outreach", true);
    }
    const [vOppAfter, vRecAfter, vCampaignAfter, vLinkAfter] = await Promise.all([
      db.query.contactOpportunities.findFirst({ where: eq(contactOpportunities.id, vOpportunity.id) }),
      db.query.recommendations.findFirst({ where: eq(recommendations.id, vRecommendation.id) }),
      db.query.outreachCampaigns.findFirst({ where: eq(outreachCampaigns.id, vCampaign.id) }),
      db.query.userRecruiterLinks.findFirst({ where: and(eq(userRecruiterLinks.userId, VICTIM), eq(userRecruiterLinks.recruiterId, vRecruiter.id)) }),
    ]);
    t.check(
      "B's opportunity, radar card, campaign and recruiter link are untouched",
      vOppAfter?.label === "VICTIM-OPPORTUNITY" && vOppAfter.status === "open" && vRecAfter?.status === "pending" &&
        vCampaignAfter?.name === "VICTIM-CAMPAIGN" && vLinkAfter?.notes === "VICTIM-NOTES" && vLinkAfter.status === "active",
      JSON.stringify({ o: vOppAfter?.label, r: vRecAfter?.status, c: vCampaignAfter?.name, l: vLinkAfter?.notes })
    );

    // request_send with B's contact: the draft is A's own and is staged, but must not be linked to B's row.
    {
      exercised.add("request_send");
      const r = (await call("request_send", { to: "someone@example.com", body: "hello", contactId: vContact.id })) as { draftId?: string };
      const row = r.draftId ? await db.query.agentSendRequests.findFirst({ where: eq(agentSendRequests.id, r.draftId) }) : undefined;
      t.check("request_send: a draft naming B's contact is A's, with no contact link", row?.userId === ATTACKER && row?.contactId === null, JSON.stringify(row ?? r).slice(0, 160));
      const own = (await call("request_send", { to: "friend@example.com", body: "hi", contactId: aContact.id })) as { draftId?: string };
      const ownRow = own.draftId ? await db.query.agentSendRequests.findFirst({ where: eq(agentSendRequests.id, own.draftId) }) : undefined;
      t.check("request_send: control — A's own contact is linked", ownRow?.contactId === aContact.id);
      const status = await call("get_send_status", { draftId: own.draftId });
      t.check("get_send_status: control — A reads A's own draft", !isToolError(status) && (status as { draftId: string }).draftId === own.draftId);
    }

    // Every tool with an id-shaped argument must have been exercised above.
    const idTools = ORBIT_TOOLS.filter((x) => Object.keys(x.inputSchema).some((k) => /Id$/.test(k) && k !== "externalId")).map((x) => x.name);
    const missed = idTools.filter((n) => !exercised.has(n));
    t.check(`every id-taking tool is exercised (${idTools.length})`, missed.length === 0, `not covered: ${missed.join(", ")}`);

    // --- B is untouched --------------------------------------------------------------------------
    t.check("B's rows read back identical after every tool call", (await victimState()) === victimBefore);
    const victimCountsAfter = await rowCountsFor(db, VICTIM);
    t.check(
      "B's per-table row counts are unchanged",
      JSON.stringify(victimCountsAfter) === JSON.stringify(victimCountsBefore),
      `${JSON.stringify(victimCountsBefore)} → ${JSON.stringify(victimCountsAfter)}`
    );
    const crossRefs = await Promise.all([
      db.select({ id: reminders.id }).from(reminders).where(and(eq(reminders.userId, ATTACKER), eq(reminders.contactId, vContact.id))),
      db.select({ id: interactions.id }).from(interactions).where(and(eq(interactions.userId, ATTACKER), eq(interactions.contactId, vContact.id))),
      db.select({ id: agentSendRequests.id }).from(agentSendRequests).where(and(eq(agentSendRequests.userId, ATTACKER), eq(agentSendRequests.contactId, vContact.id))),
    ]);
    t.check("A holds no row pointing at B's contact", crossRefs.every((rows) => rows.length === 0), JSON.stringify(crossRefs));
    const planted = await db
      .select({ id: interactions.id })
      .from(interactions)
      .where(and(inArray(interactions.userId, [VICTIM, ATTACKER]), sql`${interactions.rawNotes} like 'planted%'`));
    t.check("no planted note or interaction exists anywhere", planted.length === 0);

    // --- v1: DELETE /api/v1/webhook-endpoints/:id ------------------------------------------------
    console.log("\nv1 API: one account's key cannot delete another's webhook endpoint…");
    const key = generateApiKey();
    await db.execute(sql`
      INSERT INTO api_keys (user_id, name, kind, prefix, key_hash, scopes)
      VALUES (${ATTACKER}, 'xt key', 'api', ${key.prefix}, ${key.keyHash}, '["read","write"]'::jsonb)
    `);
    // The API is a paid feature; comp A so the route is reachable at all.
    await db.execute(sql`
      INSERT INTO user_settings (user_id, comped_plan, comped_at) VALUES (${ATTACKER}, 'max', now())
      ON CONFLICT (user_id) DO UPDATE SET comped_plan = 'max', comped_at = now()
    `);
    const [vEndpoint] = await db
      .insert(webhookEndpoints)
      .values({ userId: VICTIM, url: "https://hooks.example.com/victim", secretEncrypted: "not-a-real-ciphertext", status: "active" })
      .returning();
    const [aEndpoint] = await db
      .insert(webhookEndpoints)
      .values({ userId: ATTACKER, url: "https://hooks.example.com/attacker", secretEncrypted: "not-a-real-ciphertext", status: "active" })
      .returning();
    const del = (id: string, token: string | null = key.token) =>
      endpointDelete(
        new Request(`https://orbit.test/api/v1/webhook-endpoints/${id}`, {
          method: "DELETE",
          headers: token ? { authorization: `Bearer ${token}` } : {},
        })
      );

    let res = await del(vEndpoint.id, null);
    t.check("no key → 401", res.status === 401, String(res.status));
    res = await del(vEndpoint.id);
    const body = (await res.json()) as { error?: { code?: string } };
    t.check("A's key on B's endpoint → 404 not_found", res.status === 404 && body.error?.code === "not_found", `${res.status} ${JSON.stringify(body)}`);
    t.check("…and B's endpoint still exists", Boolean(await db.query.webhookEndpoints.findFirst({ where: eq(webhookEndpoints.id, vEndpoint.id) })));

    const list = await endpointsGet(new Request("https://orbit.test/api/v1/webhook-endpoints", { headers: { authorization: `Bearer ${key.token}` } }));
    const listed = JSON.stringify(await list.json());
    t.check("A's endpoint list shows A's endpoint and not B's", listed.includes(aEndpoint.id) && !listed.includes(vEndpoint.id), listed.slice(0, 200));

    res = await del(aEndpoint.id);
    t.check("control: A's key deletes A's own endpoint → 200", res.status === 200, String(res.status));
    t.check("…which is gone", !(await db.query.webhookEndpoints.findFirst({ where: eq(webhookEndpoints.id, aEndpoint.id) })));
    t.check("…while B's is still there", Boolean(await db.query.webhookEndpoints.findFirst({ where: eq(webhookEndpoints.id, vEndpoint.id) })));
  } finally {
    await purgeUsers(db, [VICTIM, ATTACKER]);
  }

  t.done("tenant isolation");
});
