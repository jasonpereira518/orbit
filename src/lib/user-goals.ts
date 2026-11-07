import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userGoals } from "@/db/schema";
import { UserFacingError } from "@/lib/errors";

/**
 * The user's active goal texts, used to weight closeness and to steer AI
 * suggestions toward what they're actually trying to do.
 *
 * Parameterized by userId so callers outside a server-action request context
 * (route handlers) can use it; `listActiveGoalTexts` in src/actions/goals.ts
 * wraps this with `requireUserId()`.
 *
 * Newest first, and `limit` bounds how many reach a prompt. Chat had its own private copy
 * of this query for exactly that reason; one list is better than two that can disagree about
 * which goals the user is currently working on.
 */
export async function listActiveGoalTextsForUser(
  userId: string,
  options: { limit?: number } = {}
) {
  const db = await getDb();
  const rows = await db.query.userGoals.findMany({
    where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
    columns: { text: true },
    orderBy: [desc(userGoals.createdAt)],
    ...(options.limit ? { limit: options.limit } : {}),
  });
  return rows.map((r) => r.text);
}

/**
 * Active goals WITH their ids, newest first. The brief's goal-fit judgement has to name a
 * goal it is talking about, and a text is not a stable name: the same sentence can be
 * deleted and re-added (`restoreGoal`). Everything that only steers a prompt should keep
 * using `listActiveGoalTextsForUser`; this is for the callers that store a reference.
 */
export async function listActiveGoalsForUser(
  userId: string,
  options: { limit?: number } = {}
) {
  const db = await getDb();
  return db.query.userGoals.findMany({
    where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
    columns: { id: true, text: true },
    orderBy: [desc(userGoals.createdAt)],
    ...(options.limit ? { limit: options.limit } : {}),
  });
}

/** A deleted goal, exactly as `restoreGoalForUser` needs it to put it back. */
export type GoalSnapshot = { id: string; text: string; active: number; createdAt: string };

/** Longest goal text Settings and chat accept. */
export const MAX_GOAL_CHARS = 200;

/**
 * Add one active goal. The body of `addGoal` (src/actions/goals.ts), user-scoped so chat's
 * writes (@/lib/tools/chat-writes) can call it; revalidation stays with the callers.
 */
export async function addGoalForUser(userId: string, text: string) {
  const trimmed = text.trim();
  if (!trimmed) throw new UserFacingError("Write the goal first");
  if (trimmed.length > MAX_GOAL_CHARS) throw new UserFacingError("Keep the goal under 200 characters");
  const db = await getDb();
  const [row] = await db.insert(userGoals).values({ userId, text: trimmed, active: 1 }).returning();
  return row;
}

/** Hard-delete one of the user's goals — see `deleteGoal` for why — returning what Undo needs. */
export async function deleteGoalForUser(userId: string, id: string): Promise<GoalSnapshot | null> {
  const db = await getDb();
  const [deleted] = await db
    .delete(userGoals)
    .where(and(eq(userGoals.id, id), eq(userGoals.userId, userId)))
    .returning();
  return deleted
    ? { id: deleted.id, text: deleted.text, active: deleted.active, createdAt: deleted.createdAt.toISOString() }
    : null;
}

/**
 * Undo for `deleteGoalForUser`: the row back with its own id and `createdAt`. The snapshot is
 * re-validated as an add would be, and an id that already exists is left alone.
 */
export async function restoreGoalForUser(userId: string, snapshot: GoalSnapshot): Promise<{ restored: boolean }> {
  const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
  const createdAt = new Date(snapshot?.createdAt);
  if (typeof snapshot?.id !== "string" || !text || text.length > MAX_GOAL_CHARS || Number.isNaN(createdAt.getTime())) {
    return { restored: false };
  }
  const db = await getDb();
  const inserted = await db
    .insert(userGoals)
    .values({ id: snapshot.id, userId, text, active: snapshot.active === 0 ? 0 : 1, createdAt })
    .onConflictDoNothing()
    .returning();
  return { restored: inserted.length > 0 };
}
