/**
 * Chat writes for the rest of Orbit (plan Phase 2b): goals and schools, opportunities and
 * radar, outreach (never a send), recruiters, meetings, an email draft and two settings.
 *
 * Same contract as the core catalog in @/lib/tools/chat-writes, whose top comment is the
 * write invariant: the model only proposes, a person's click (or an opted-in auto-apply,
 * @/lib/chat-auto-apply) commits from the stored, re-validated input, every id must have been
 * in front of the model this turn, and each commit is scoped to the caller by the lib function
 * it calls.
 */
import { z } from "zod";
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
};
