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
import { addGoalForUser, deleteGoalForUser, MAX_GOAL_CHARS, restoreGoalForUser, type GoalSnapshot } from "@/lib/user-goals";
import { name, s, text, uuid, type ChatWrite, type UndoFn } from "@/lib/tools/chat-write-kit";

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
};
