"use server";

import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userGoals } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  addGoalForUser,
  deleteGoalForUser,
  listActiveGoalTextsForUser,
  restoreGoalForUser,
  type GoalSnapshot,
} from "@/lib/user-goals";
import { revalidatePathIfRequestScoped } from "@/lib/reminder-paths";
import { asActionResult } from "@/lib/errors";

export async function listGoals() {
  const userId = await requireUserId();
  const db = await getDb();
  return db.query.userGoals.findMany({
    where: eq(userGoals.userId, userId),
    orderBy: [desc(userGoals.createdAt)],
  });
}

export async function listActiveGoalTexts() {
  return listActiveGoalTextsForUser(await requireUserId());
}

/** Validation comes back as data — see `asActionResult` in lib/errors.ts. */
export async function addGoal(text: string) {
  return asActionResult(async () => {
    const row = await addGoalForUser(await requireUserId(), text);
    revalidateGoalPaths();
    return row;
  });
}

function revalidateGoalPaths() {
  for (const path of ["/settings", "/graph", "/contacts", "/dashboard"]) {
    revalidatePathIfRequestScoped(path);
  }
}

/**
 * Returns the deleted row so the toast can offer Undo — see `restoreGoal`.
 *
 * Why a hard delete plus a re-insert, rather than flipping the `active` column: four
 * readers ignore `active` (`listGoals` below, `lib/graph-data.ts`, and two admin counts),
 * so a soft-deleted goal would stay visible in Settings and on the constellation.
 * `user_goals` has no inbound foreign keys, so putting the row back with its own id and
 * `createdAt` is an exact restore that asks nothing of any reader.
 */
export async function deleteGoal(id: string) {
  const snapshot = await deleteGoalForUser(await requireUserId(), id);
  revalidateGoalPaths();
  return snapshot;
}

/**
 * Undo for `deleteGoal`: re-insert the row with its original id and `createdAt`, so it
 * returns to the same place in the list. The snapshot comes from the client, so the owner
 * is always the signed-in user, the text is re-validated as `addGoal` would, and an id
 * that already exists is left alone rather than overwritten.
 */
export async function restoreGoal(snapshot: GoalSnapshot) {
  const result = await restoreGoalForUser(await requireUserId(), snapshot);
  revalidateGoalPaths();
  return result;
}
