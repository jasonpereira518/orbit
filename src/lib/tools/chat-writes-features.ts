/**
 * Chat writes for the rest of Orbit (plan Phase 2b): goals and schools, opportunities and
 * radar, outreach (never a send), recruiters, meetings, an email draft and radar's autopilot.
 *
 * Deliberately absent: the user's writing instructions. They are injected into every draft
 * prompt Orbit writes, so a model that could set them could plant a standing instruction —
 * a smoke test keeps them out of src/lib/tools altogether.
 *
 * Same contract as the core catalog in @/lib/tools/chat-writes, whose top comment is the
 * write invariant: the model only proposes, a person's click (or an opted-in auto-apply,
 * @/lib/chat-auto-apply) commits from the stored, re-validated input, every id must have been
 * in front of the model this turn, and each commit is scoped to the caller by the lib function
 * it calls.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { UserFacingError } from "@/lib/errors";
import { listSchools, setSchools } from "@/lib/events/target-companies";
import type { ContactOpportunity } from "@/db/schema";
import {
  createOpportunityForUser,
  deleteOpportunityForUser,
  restoreOpportunityForUser,
  updateOpportunityForUser,
} from "@/lib/contact-opportunities";
import {
  MAX_OPPORTUNITY_LABEL_CHARS,
  OPPORTUNITY_KINDS,
  OPPORTUNITY_STATUSES,
  type OpportunityKind,
  type OpportunityStatus,
} from "@/lib/opportunity-kinds";
import {
  dismissRecommendationForUser,
  restoreRecommendationForUser,
  scheduleRecommendationForUser,
  snoozeRecommendationForUser,
} from "@/lib/radar/actions-core";
import {
  assertOutreachForUser,
  logMessageOutcomeForUser,
  updateCampaignWordingForUser,
  updateOutreachDraftForUser,
  type CampaignWording,
} from "@/lib/outreach-writes";
import {
  assertRecruitersForUser,
  logRecruiterForUser,
  removeMyLinkForUser,
  updateMyLinkForUser,
  type RecruiterLinkPatch,
} from "@/lib/recruiter-writes";
import {
  discardMeetingSessionRow,
  getMeetingSession,
  setMeetingSessionEventLink,
  updateMeetingDetails,
} from "@/lib/meeting-sessions";
import { loadRadarAutopilot, setRadarAutopilotForUser } from "@/lib/radar/autopilot";
import { KIND_LABELS, RECOMMENDATION_KINDS, type RecommendationKind } from "@/lib/radar/types";
import { requireReleasedSurface } from "@/lib/surface-visibility";
import { addGoalForUser, deleteGoalForUser, MAX_GOAL_CHARS, restoreGoalForUser, type GoalSnapshot } from "@/lib/user-goals";
import { isoDay, name, s, text, uuid, type ChatWrite, type UndoFn } from "@/lib/tools/chat-write-kit";

const opportunityKind = z.enum(OPPORTUNITY_KINDS.map((k) => k.value) as [OpportunityKind, ...OpportunityKind[]]);
const opportunityStatus = z.enum(OPPORTUNITY_STATUSES.map((st) => st.value) as [OpportunityStatus, ...OpportunityStatus[]]);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(s).filter(Boolean) : []);
const quote = (v: string, max = 80) => `“${v.length > max ? `${v.slice(0, max - 1)}…` : v}”`;

export const FEATURE_WRITES: readonly ChatWrite[] = [
  /* ------------------------------------------------------------- goals, schools ----- */
  {
    name: "add_goal",
    title: "Add a goal",
    description: "Propose adding a goal the user is working toward (what they want from their network), in their words.",
    inputSchema: { text: z.string().min(1).max(MAX_GOAL_CHARS) },
    tier: "auto",
    refs: () => ({}),
    preview: (i) => `Add the goal ${quote(text(i.text, MAX_GOAL_CHARS))}`,
    async commit(userId, i) {
      const row = await addGoalForUser(userId, text(i.text, MAX_GOAL_CHARS));
      return { resultId: row.id, href: "/settings", undo: { tool: "delete_created_goal", input: { goalId: row.id } } };
    },
  },
  {
    name: "remove_goal",
    title: "Remove a goal",
    description: "Propose removing one of the user's goals, by the goal id get_goals returned. Only when asked.",
    inputSchema: { goalId: uuid },
    tier: "confirm",
    refs: (i) => ({ goals: [s(i.goalId)] }),
    preview: (i, sc) => `Remove the goal ${quote(name(sc.goals, i.goalId, "this goal"))}`,
    async commit(userId, i) {
      const snapshot = await deleteGoalForUser(userId, s(i.goalId));
      if (!snapshot) throw new UserFacingError("That goal is gone — it may have been removed already");
      return { resultId: null, href: "/settings", undo: { tool: "restore_goal", input: { snapshot } } };
    },
  },
  {
    name: "set_schools",
    title: "Set the user's schools",
    description:
      "Propose replacing the list of schools the user went to (up to 10) — the whole list, so include the ones to keep. " +
      "An empty list clears it.",
    inputSchema: { schools: z.array(z.string().min(1).max(120)).max(10) },
    tier: "confirm",
    refs: () => ({}),
    preview(i) {
      const schools = list(i.schools).map((x) => text(x, 120));
      return schools.length ? `Set your schools to ${schools.join(", ")}` : "Clear your schools";
    },
    async commit(userId, i) {
      const before = await listSchools(userId);
      await setSchools(userId, list(i.schools).map((x) => text(x, 120)));
      return { resultId: null, href: "/settings", undo: { tool: "restore_schools", input: { schools: before } } };
    },
  },

  /* ----------------------------------------------------------------- opportunities ----- */
  {
    name: "create_opportunity",
    title: "Track an opportunity",
    description:
      "Propose tracking an opportunity on one of the user's contacts — a referral, intro, role, investor, ask — " +
      "with what it is (label), which way it runs (they_offer / you_ask) and any due day.",
    inputSchema: {
      contactId: uuid,
      kind: opportunityKind,
      label: z.string().min(1).max(MAX_OPPORTUNITY_LABEL_CHARS),
      direction: z.enum(["they_offer", "you_ask"]).optional(),
      due_date: isoDay.optional(),
    },
    tier: "auto",
    refs: (i) => ({ contacts: [s(i.contactId)] }),
    contactOf: (i) => s(i.contactId),
    preview: (i, sc) =>
      `Track ${quote(text(i.label, MAX_OPPORTUNITY_LABEL_CHARS))} (${s(i.kind).replace(/_/g, " ")}) on ${name(sc.contacts, i.contactId, "this contact")}${i.due_date ? `, due ${s(i.due_date).slice(0, 10)}` : ""}`,
    async commit(userId, i) {
      const row = await createOpportunityForUser(userId, {
        contactId: s(i.contactId),
        kind: s(i.kind),
        label: text(i.label, MAX_OPPORTUNITY_LABEL_CHARS),
        direction: i.direction ? s(i.direction) : null,
        dueDateIso: i.due_date ? s(i.due_date).slice(0, 10) : null,
      });
      return { resultId: row.id, href: `/contacts/${row.contactId}`, undo: { tool: "delete_created_opportunity", input: { opportunityId: row.id } } };
    },
  },
  {
    name: "update_opportunity",
    title: "Edit an opportunity",
    description: "Propose changing an opportunity's label, kind, direction or due day, by the id list_opportunities returned.",
    inputSchema: {
      opportunityId: uuid,
      kind: opportunityKind.optional(),
      label: z.string().min(1).max(MAX_OPPORTUNITY_LABEL_CHARS).optional(),
      direction: z.enum(["they_offer", "you_ask"]).optional(),
      due_date: isoDay.optional(),
    },
    tier: "confirm",
    refs: (i) => ({ opportunities: [s(i.opportunityId)] }),
    preview(i, sc) {
      const parts = [
        i.label ? `label → ${quote(text(i.label, MAX_OPPORTUNITY_LABEL_CHARS))}` : "",
        i.kind ? `kind → ${s(i.kind).replace(/_/g, " ")}` : "",
        i.direction ? `direction → ${s(i.direction) === "you_ask" ? "you ask" : "they offer"}` : "",
        i.due_date ? `due → ${s(i.due_date).slice(0, 10)}` : "",
      ].filter(Boolean);
      return `Update the opportunity ${quote(name(sc.opportunities, i.opportunityId, "this opportunity"))}: ${parts.join(", ") || "no change"}`;
    },
    async commit(userId, i) {
      const patch = {
        ...(i.kind ? { kind: s(i.kind) } : {}),
        ...(i.label ? { label: text(i.label, MAX_OPPORTUNITY_LABEL_CHARS) } : {}),
        ...(i.direction ? { direction: s(i.direction) } : {}),
        ...(i.due_date ? { dueDateIso: s(i.due_date).slice(0, 10) } : {}),
      };
      if (!Object.keys(patch).length) throw new UserFacingError("Nothing to change");
      const changed = await updateOpportunityForUser(userId, s(i.opportunityId), patch);
      if (!changed) throw new UserFacingError("That opportunity is gone — it may have been deleted");
      const b = changed.before;
      return {
        resultId: b.id,
        href: `/contacts/${b.contactId}`,
        undo: {
          tool: "restore_opportunity_fields",
          input: {
            opportunityId: b.id,
            patch: {
              kind: b.kind,
              label: b.label,
              direction: b.direction,
              dueDateIso: b.dueDate ? b.dueDate.toISOString().slice(0, 10) : null,
            },
          },
        },
      };
    },
  },
  {
    name: "set_opportunity_status",
    title: "Move an opportunity along",
    description: "Propose setting an opportunity's status — open, in_progress, landed, passed or dismissed — by its id.",
    inputSchema: { opportunityId: uuid, status: opportunityStatus },
    tier: "auto",
    refs: (i) => ({ opportunities: [s(i.opportunityId)] }),
    preview: (i, sc) =>
      `Mark the opportunity ${quote(name(sc.opportunities, i.opportunityId, "this opportunity"))} ${s(i.status).replace(/_/g, " ")}`,
    async commit(userId, i) {
      const changed = await updateOpportunityForUser(userId, s(i.opportunityId), { status: s(i.status) });
      if (!changed) throw new UserFacingError("That opportunity is gone — it may have been deleted");
      return {
        resultId: changed.after.id,
        href: `/contacts/${changed.after.contactId}`,
        undo: { tool: "restore_opportunity_fields", input: { opportunityId: changed.before.id, patch: { status: changed.before.status } } },
      };
    },
  },
  {
    name: "delete_opportunity",
    title: "Delete an opportunity",
    description: "Propose deleting an opportunity that should never have been tracked, by its id. Only when asked; to close one, set its status instead.",
    inputSchema: { opportunityId: uuid },
    tier: "confirm",
    refs: (i) => ({ opportunities: [s(i.opportunityId)] }),
    preview: (i, sc) => `Delete the opportunity ${quote(name(sc.opportunities, i.opportunityId, "this opportunity"))}`,
    async commit(userId, i) {
      const row = await deleteOpportunityForUser(userId, s(i.opportunityId));
      if (!row) throw new UserFacingError("That opportunity is gone — it may have been deleted");
      return { resultId: null, href: `/contacts/${row.contactId}`, undo: { tool: "restore_opportunity", input: { row } } };
    },
  },

  /* ------------------------------------------------------------------------- radar ----- */
  {
    name: "schedule_recommendation",
    title: "Act on a radar card",
    description:
      "Propose acting on one of radar's suggestions (id from list_radar_cards) by scheduling a follow-up with that person " +
      "in 3, 7 or 14 days.",
    inputSchema: { recommendationId: uuid, days: z.union([z.literal(3), z.literal(7), z.literal(14)]) },
    // A follow-up reminder is made and restoring the card would not remove it, so this asks.
    tier: "confirm",
    refs: (i) => ({ recommendations: [s(i.recommendationId)] }),
    preview: (i, sc) => `Follow up with ${name(sc.recommendations, i.recommendationId, "this person")} in ${Number(i.days)} days, from radar`,
    async commit(userId, i) {
      const out = await scheduleRecommendationForUser(userId, s(i.recommendationId), Number(i.days) as 3 | 7 | 14);
      if (!out.ok) throw new UserFacingError("That radar card has moved on — open radar to see it");
      return { resultId: null, href: "/reminders", undo: null };
    },
  },
  {
    name: "snooze_recommendation",
    title: "Snooze a radar card",
    description: "Propose snoozing one of radar's suggestions for a week (1w) or a month (1m).",
    inputSchema: { recommendationId: uuid, length: z.enum(["1w", "1m"]) },
    tier: "auto",
    refs: (i) => ({ recommendations: [s(i.recommendationId)] }),
    preview: (i, sc) =>
      `Snooze the radar card for ${name(sc.recommendations, i.recommendationId, "this person")} for a ${s(i.length) === "1m" ? "month" : "week"}`,
    async commit(userId, i) {
      const out = await snoozeRecommendationForUser(userId, s(i.recommendationId), s(i.length) as "1w" | "1m");
      if (!out.ok) throw new UserFacingError("That radar card has moved on — open radar to see it");
      return { resultId: null, href: "/radar", undo: { tool: "restore_recommendation", input: { recommendationId: s(i.recommendationId) } } };
    },
  },
  {
    name: "dismiss_recommendation",
    title: "Dismiss a radar card",
    description: "Propose dismissing one of radar's suggestions the user does not want to act on.",
    inputSchema: { recommendationId: uuid },
    tier: "confirm",
    refs: (i) => ({ recommendations: [s(i.recommendationId)] }),
    preview: (i, sc) => `Dismiss the radar card for ${name(sc.recommendations, i.recommendationId, "this person")}`,
    async commit(userId, i) {
      const out = await dismissRecommendationForUser(userId, s(i.recommendationId));
      if (!out.ok) throw new UserFacingError("That radar card has moved on — open radar to see it");
      return { resultId: null, href: "/radar", undo: { tool: "restore_recommendation", input: { recommendationId: s(i.recommendationId) } } };
    },
  },

  /* ------------------------------------------------------------- outreach (no sends) ----- */
  {
    name: "update_campaign",
    title: "Edit a campaign's wording",
    description:
      "Propose changing an outreach campaign's name, message intent, call to action or tone (campaign id from list_campaigns). " +
      "Never its audience, status or schedule, and nothing is sent.",
    inputSchema: {
      campaignId: uuid,
      name: z.string().min(1).max(200).optional(),
      message_intent: z.string().max(2000).optional(),
      reply_cta: z.string().max(500).optional(),
      tone: z.string().max(64).optional(),
    },
    tier: "confirm",
    refs: (i) => ({ campaigns: [s(i.campaignId)] }),
    preview(i, sc) {
      const parts = [
        i.name ? `name → ${quote(text(i.name, 200))}` : "",
        i.message_intent ? `intent → ${quote(text(i.message_intent, 2000))}` : "",
        i.reply_cta ? `call to action → ${quote(text(i.reply_cta, 500))}` : "",
        i.tone ? `tone → ${quote(text(i.tone, 64))}` : "",
      ].filter(Boolean);
      return `Update the campaign ${quote(name(sc.campaigns, i.campaignId, "this campaign"))}: ${parts.join(", ") || "no change"}`;
    },
    async commit(userId, i) {
      await assertOutreachForUser(userId);
      const wording: CampaignWording = {
        ...(i.name ? { name: text(i.name, 200) } : {}),
        ...(i.message_intent ? { messageIntent: text(i.message_intent, 2000) } : {}),
        ...(i.reply_cta ? { replyCta: text(i.reply_cta, 500) } : {}),
        ...(i.tone ? { tone: text(i.tone, 64) } : {}),
      };
      if (!Object.keys(wording).length) throw new UserFacingError("Nothing to change");
      const changed = await updateCampaignWordingForUser(userId, s(i.campaignId), wording);
      if (!changed) throw new UserFacingError("That campaign is gone — it may have been deleted");
      return {
        resultId: changed.after.id,
        href: `/outreach/${changed.after.id}`,
        undo: { tool: "restore_campaign_wording", input: { campaignId: changed.after.id, wording: changed.before } },
      };
    },
  },
  {
    name: "update_outreach_draft",
    title: "Edit an outreach draft",
    description:
      "Propose rewriting an outreach message that has not gone out (messageId from list_outreach_messages): its subject, " +
      "its text, or both. The user still sends it from the outreach page.",
    inputSchema: {
      messageId: uuid,
      subject: z.string().max(200).optional(),
      body: z.string().min(1).max(4000).optional(),
    },
    tier: "confirm",
    refs: (i) => ({ outreachMessages: [s(i.messageId)] }),
    preview(i, sc) {
      const what = [i.subject ? `subject → ${quote(text(i.subject, 200))}` : "", i.body ? `text → ${quote(text(i.body, 4000), 120)}` : ""].filter(Boolean);
      return `Rewrite the draft to ${name(sc.outreachMessages, i.messageId, "this prospect")}: ${what.join(", ") || "no change"}`;
    },
    async commit(userId, i) {
      await assertOutreachForUser(userId);
      if (!i.subject && !i.body) throw new UserFacingError("Nothing to change");
      const changed = await updateOutreachDraftForUser(
        userId,
        {
          messageId: s(i.messageId),
          ...(i.subject ? { subject: text(i.subject, 200) } : {}),
          ...(i.body ? { body: text(i.body, 4000) } : {}),
        },
        { unsentOnly: true }
      );
      if (!changed) throw new UserFacingError("That message is gone — it may have been deleted");
      return {
        resultId: changed.after.id,
        href: `/outreach/${changed.campaignId}`,
        undo: { tool: "restore_outreach_draft", input: { messageId: changed.after.id, ...changed.before } },
      };
    },
  },
  {
    name: "log_outreach_outcome",
    title: "Log how an outreach message landed",
    description:
      "Propose recording the outcome of an outreach message the user sent (messageId from list_outreach_messages): " +
      "positive_reply, negative_reply, neutral_reply, bounced or unsubscribed, with a short note.",
    inputSchema: {
      messageId: uuid,
      outcome: z.enum(["positive_reply", "negative_reply", "neutral_reply", "bounced", "unsubscribed"]),
      notes: z.string().max(1000).optional(),
    },
    // Moves the prospect's status and skips their scheduled follow-ups, which no undo would
    // put back exactly — so this asks, and has none.
    tier: "confirm",
    refs: (i) => ({ outreachMessages: [s(i.messageId)] }),
    preview: (i, sc) =>
      `Log ${s(i.outcome).replace(/_/g, " ")} from ${name(sc.outreachMessages, i.messageId, "this prospect")}${s(i.outcome) === "bounced" ? "" : " (their scheduled follow-ups stop)"}`,
    async commit(userId, i) {
      await assertOutreachForUser(userId);
      const logged = await logMessageOutcomeForUser(userId, {
        messageId: s(i.messageId),
        outcome: s(i.outcome) as "positive_reply",
        notes: i.notes ? text(i.notes, 1000) : null,
      });
      if (!logged) throw new UserFacingError("That message is gone — it may have been deleted");
      return { resultId: logged.message.id, href: `/outreach/${logged.campaignId}`, undo: null };
    },
  },

  /* -------------------------------------------------------------------- recruiters ----- */
  {
    name: "log_recruiter",
    title: "Log a recruiter",
    description:
      "Propose adding a recruiter the user is working with: name, firm, specialty, contact details, status and notes. " +
      "Orbit keeps one shared directory entry per recruiter; the user's status, rating and notes stay theirs.",
    inputSchema: {
      full_name: z.string().min(1).max(200),
      firm: z.string().max(200).optional(),
      specialty: z.array(z.string().min(1).max(60)).max(5).optional(),
      email: z.string().email().max(320).optional(),
      linkedin_url: z.string().url().max(500).optional(),
      status: z.enum(["planned", "contacted", "active", "archived"]).optional(),
      notes: z.string().max(2000).optional(),
    },
    tier: "confirm",
    refs: () => ({}),
    preview: (i) =>
      `Log ${text(i.full_name, 200)}${i.firm ? ` (${text(i.firm, 200)})` : ""} as a recruiter — Orbit keeps one shared directory entry per recruiter; your status and notes stay yours`,
    async commit(userId, i) {
      await assertRecruitersForUser(userId);
      const { id, linkCreated } = await logRecruiterForUser(userId, {
        fullName: text(i.full_name, 200),
        ...(i.firm ? { firm: text(i.firm, 200) } : {}),
        ...(i.specialty ? { specialty: list(i.specialty).map((x) => text(x, 60)) } : {}),
        ...(i.email ? { email: s(i.email).trim() } : {}),
        ...(i.linkedin_url ? { linkedinUrl: s(i.linkedin_url).trim() } : {}),
        ...(i.status ? { status: s(i.status) as "planned" } : {}),
        ...(i.notes ? { notes: text(i.notes, 2000) } : {}),
        source: "chat",
      });
      // Undo takes back the user's own link — only if this made it; the shared row stays.
      return { resultId: id, href: `/recruiters/${id}`, undo: linkCreated ? { tool: "remove_recruiter_link", input: { recruiterId: id } } : null };
    },
  },
  {
    name: "update_recruiter_link",
    title: "Update a recruiter",
    description:
      "Propose changing the user's own status (planned, contacted, active, archived), rating (1–5) or notes for a recruiter " +
      "they have logged (recruiterId from list_my_recruiters).",
    inputSchema: {
      recruiterId: uuid,
      status: z.enum(["planned", "contacted", "active", "archived"]).optional(),
      personal_rating: z.number().int().min(1).max(5).optional(),
      notes: z.string().max(2000).optional(),
    },
    tier: "auto",
    // A status or a rating is the user's own bookkeeping; notes are free text, so they ask.
    tierFor: (i) => (i.notes !== undefined ? "confirm" : "auto"),
    refs: (i) => ({ recruiters: [s(i.recruiterId)] }),
    preview(i, sc) {
      const parts = [
        i.status ? `status → ${s(i.status)}` : "",
        i.personal_rating ? `your rating → ${Number(i.personal_rating)}/5` : "",
        i.notes !== undefined ? `notes → ${quote(text(i.notes, 2000))}` : "",
      ].filter(Boolean);
      return `Update ${name(sc.recruiters, i.recruiterId, "this recruiter")}: ${parts.join(", ") || "no change"}`;
    },
    async commit(userId, i) {
      await assertRecruitersForUser(userId);
      const patch: RecruiterLinkPatch = {
        ...(i.status ? { status: s(i.status) as "planned" } : {}),
        ...(i.personal_rating ? { personalRating: Number(i.personal_rating) } : {}),
        ...(i.notes !== undefined ? { notes: text(i.notes, 2000) || null } : {}),
      };
      if (!Object.keys(patch).length) throw new UserFacingError("Nothing to change");
      const changed = await updateMyLinkForUser(userId, s(i.recruiterId), patch);
      if (!changed) throw new UserFacingError("You haven’t logged that recruiter yet");
      return {
        resultId: s(i.recruiterId),
        href: `/recruiters/${s(i.recruiterId)}`,
        undo: { tool: "restore_recruiter_link", input: { recruiterId: s(i.recruiterId), patch: changed.before } },
      };
    },
  },

  /* ---------------------------------------------------------------------- meetings ----- */
  {
    name: "rename_meeting",
    title: "Rename a recorded meeting",
    description: "Propose giving one of the user's recorded meetings a clearer title (meetingId from search_meetings).",
    inputSchema: { meetingId: uuid, title: z.string().min(1).max(200) },
    tier: "auto",
    refs: (i) => ({ meetings: [s(i.meetingId)] }),
    preview: (i, sc) => `Rename the meeting ${quote(name(sc.meetings, i.meetingId, "this meeting"))} to ${quote(text(i.title, 200))}`,
    async commit(userId, i) {
      const before = await getMeetingSession(userId, s(i.meetingId));
      if (!before) throw new UserFacingError("That meeting is gone — it may have been discarded");
      const row = await updateMeetingDetails(userId, before.id, { title: text(i.title, 200) });
      if (!row) throw new UserFacingError("That meeting is gone — it may have been discarded");
      return { resultId: row.id, href: `/meetings/${row.id}`, undo: { tool: "restore_meeting_title", input: { meetingId: row.id, title: before.title } } };
    },
  },
  {
    name: "link_meeting_to_event",
    title: "Say which calendar event a meeting was",
    description:
      "Propose linking one of the user's recorded meetings (meetingId from search_meetings) to the calendar event it was " +
      "(eventId from upcoming_meetings or meeting_context), so its series and attendees line up.",
    inputSchema: { meetingId: uuid, calendarEventId: uuid },
    tier: "auto",
    refs: (i) => ({ meetings: [s(i.meetingId)], calendarEvents: [s(i.calendarEventId)] }),
    preview: (i, sc) =>
      `Link the meeting ${quote(name(sc.meetings, i.meetingId, "this meeting"))} to the calendar event ${quote(name(sc.calendarEvents, i.calendarEventId, "this event"))}`,
    async commit(userId, i) {
      const before = await getMeetingSession(userId, s(i.meetingId));
      if (!before) throw new UserFacingError("That meeting is gone — it may have been discarded");
      const db = await getDb();
      const event = await db.query.calendarEvents.findFirst({
        where: and(eq(calendarEvents.id, s(i.calendarEventId)), eq(calendarEvents.userId, userId)),
        columns: { providerEventId: true, seriesId: true },
      });
      if (!event) throw new UserFacingError("That calendar event is gone — try again after the calendar syncs");
      await setMeetingSessionEventLink(userId, before.id, { eventKey: event.providerEventId, seriesId: event.seriesId });
      return {
        resultId: before.id,
        href: `/meetings/${before.id}`,
        undo: { tool: "restore_meeting_link", input: { meetingId: before.id, eventKey: before.calendarEventKey, seriesId: before.calendarSeriesId } },
      };
    },
  },
  {
    name: "discard_meeting",
    title: "Discard a recorded meeting",
    description: "Propose throwing away one of the user's recorded meetings and its transcript (meetingId from search_meetings). Only when asked. Cannot be undone.",
    inputSchema: { meetingId: uuid },
    tier: "confirm",
    destructive: true,
    refs: (i) => ({ meetings: [s(i.meetingId)] }),
    preview: (i, sc) => `Discard the meeting ${quote(name(sc.meetings, i.meetingId, "this meeting"))} and its whole transcript. This cannot be undone.`,
    async commit(userId, i) {
      if (!(await discardMeetingSessionRow(userId, s(i.meetingId)))) throw new UserFacingError("That meeting is gone — it may have been discarded");
      return { resultId: null, href: "/meetings", undo: null };
    },
  },

  /* --------------------------------------------------------- an email draft, settings ----- */
  {
    name: "draft_email",
    title: "Draft an email",
    description:
      "Propose an email to one of the user's contacts, in the user's voice: the text only. The card opens Orbit's send " +
      "dialog with it prefilled — the user checks the address and subject there and presses Send themselves. Nothing is sent from here.",
    inputSchema: { contactId: uuid, body: z.string().min(1).max(4000) },
    tier: "confirm",
    opensDialog: "gmail_send",
    refs: (i) => ({ contacts: [s(i.contactId)] }),
    contactOf: (i) => s(i.contactId),
    preview: (i, sc) => `Email ${name(sc.contacts, i.contactId, "this contact")}: ${quote(text(i.body, 4000), 120)} — you review and send it`,
    // The card opens the send dialog; this only marks it done once the dialog says it went.
    // It never sends: the dialog's own Send (`sendChatDraftViaGmail`) is the only send.
    async commit() {
      return { resultId: null, href: null, undo: null };
    },
  },
  {
    name: "set_radar_autopilot",
    title: "Radar autopilot",
    description:
      "Propose turning radar's autopilot on or off for one kind of card (prep, heads_up, follow_up, opportunity, reach_out, " +
      "reconnect). With it on, radar schedules a follow-up for that kind of card by itself. It never sends.",
    inputSchema: { kind: z.enum(RECOMMENDATION_KINDS), on: z.boolean() },
    tier: "confirm",
    refs: () => ({}),
    preview: (i) =>
      `Turn radar autopilot ${i.on === true ? "on" : "off"} for ${KIND_LABELS[s(i.kind) as RecommendationKind] ?? "that kind of"} cards${i.on === true ? " — radar will schedule those follow-ups itself" : ""}`,
    async commit(userId, i) {
      await requireReleasedSurface(userId, "page.radar");
      const kind = s(i.kind) as RecommendationKind;
      const before = (await loadRadarAutopilot(userId))[kind] === true;
      await setRadarAutopilotForUser(userId, kind, i.on === true);
      return { resultId: null, href: "/radar", undo: { tool: "restore_radar_autopilot", input: { kind, on: before } } };
    },
  },
];

export const FEATURE_UNDO: Record<string, UndoFn> = {
  async delete_created_goal(userId, input) {
    await deleteGoalForUser(userId, s(input.goalId));
  },
  async restore_goal(userId, input) {
    const { restored } = await restoreGoalForUser(userId, input.snapshot as GoalSnapshot);
    if (!restored) throw new UserFacingError("That goal is back already — or changed since");
  },
  async restore_schools(userId, input) {
    await setSchools(userId, list(input.schools));
  },
  async delete_created_opportunity(userId, input) {
    await deleteOpportunityForUser(userId, s(input.opportunityId));
  },
  async restore_opportunity_fields(userId, input) {
    const changed = await updateOpportunityForUser(userId, s(input.opportunityId), (input.patch ?? {}) as Record<string, string | null>);
    if (!changed) throw new UserFacingError("That opportunity is gone — it may have been deleted");
  },
  async restore_opportunity(userId, input) {
    await restoreOpportunityForUser(userId, input.row as ContactOpportunity);
  },
  async restore_recommendation(userId, input) {
    const { restored } = await restoreRecommendationForUser(userId, s(input.recommendationId));
    if (!restored) throw new UserFacingError("Radar has a newer card for that person now");
  },
  async restore_campaign_wording(userId, input) {
    const changed = await updateCampaignWordingForUser(userId, s(input.campaignId), (input.wording ?? {}) as CampaignWording);
    if (!changed) throw new UserFacingError("That campaign is gone — it may have been deleted");
  },
  async restore_outreach_draft(userId, input) {
    const changed = await updateOutreachDraftForUser(
      userId,
      { messageId: s(input.messageId), subject: (input.subject as string | null) ?? null, body: s(input.body) },
      { unsentOnly: true }
    );
    if (!changed) throw new UserFacingError("That message is gone — it may have been deleted");
  },
  async remove_recruiter_link(userId, input) {
    await removeMyLinkForUser(userId, s(input.recruiterId));
  },
  async restore_recruiter_link(userId, input) {
    const changed = await updateMyLinkForUser(userId, s(input.recruiterId), (input.patch ?? {}) as RecruiterLinkPatch);
    if (!changed) throw new UserFacingError("You no longer have that recruiter logged");
  },
  async restore_meeting_title(userId, input) {
    const row = await updateMeetingDetails(userId, s(input.meetingId), { title: (input.title as string | null) ?? null });
    if (!row) throw new UserFacingError("That meeting is gone — it may have been discarded");
  },
  async restore_meeting_link(userId, input) {
    const ok = await setMeetingSessionEventLink(userId, s(input.meetingId), {
      eventKey: (input.eventKey as string | null) ?? null,
      seriesId: (input.seriesId as string | null) ?? null,
    });
    if (!ok) throw new UserFacingError("That meeting is gone — it may have been discarded");
  },
  async restore_radar_autopilot(userId, input) {
    await setRadarAutopilotForUser(userId, s(input.kind) as RecommendationKind, input.on === true);
  },
};
