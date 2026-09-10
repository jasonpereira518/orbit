"use server";

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { userGoals } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { revalidatePathIfRequestScoped } from "@/lib/reminder-paths";

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

export async function addGoal(text: string) {
  const userId = await requireUserId();
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Goal text is required");
  if (trimmed.length > 200) throw new Error("Goal must be under 200 characters");

  const db = await getDb();
  const [row] = await db
    .insert(userGoals)
    .values({
      userId,
      text: trimmed,
      active: 1,
    })
    .returning();

  revalidatePath("/settings");
  revalidatePath("/graph");
  revalidatePath("/contacts");
  revalidatePath("/dashboard");
  return row;
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
  const userId = await requireUserId();
  const db = await getDb();
  const [deleted] = await db
    .delete(userGoals)
    .where(and(eq(userGoals.id, id), eq(userGoals.userId, userId)))
    .returning();

  revalidateGoalPaths();
  return deleted
    ? {
        id: deleted.id,
        text: deleted.text,
        active: deleted.active,
        createdAt: deleted.createdAt.toISOString(),
      }
    : null;
}

/**
 * Undo for `deleteGoal`: re-insert the row with its original id and `createdAt`, so it
 * returns to the same place in the list. The snapshot comes from the client, so the owner
 * is always the signed-in user, the text is re-validated as `addGoal` would, and an id
 * that already exists is left alone rather than overwritten.
 */
export async function restoreGoal(snapshot: {
  id: string;
  text: string;
  active: number;
  createdAt: string;
}) {
  const userId = await requireUserId();
  const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
  const createdAt = new Date(snapshot?.createdAt);
  if (
    typeof snapshot?.id !== "string" ||
    !text ||
    text.length > 200 ||
    Number.isNaN(createdAt.getTime())
  ) {
    return { restored: false };
  }

  const db = await getDb();
  const inserted = await db
    .insert(userGoals)
    .values({
      id: snapshot.id,
      userId,
      text,
      active: snapshot.active === 0 ? 0 : 1,
      createdAt,
    })
    .onConflictDoNothing()
    .returning();

  revalidateGoalPaths();
  return { restored: inserted.length > 0 };
}
