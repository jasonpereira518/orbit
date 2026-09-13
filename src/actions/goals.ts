"use server";

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { userGoals } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";

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

  // Adding the same goal twice produced two identical pills, with no way to remove
  // either from the dashboard card. Case- and whitespace-insensitive, because "Land a
  // seed round" and "land a seed round " are the same intention.
  const existing = await db.query.userGoals.findMany({
    where: eq(userGoals.userId, userId),
  });
  const normalized = trimmed.toLowerCase().replace(/\s+/g, " ");
  const duplicate = existing.find(
    (g) => g.text.trim().toLowerCase().replace(/\s+/g, " ") === normalized
  );

  if (duplicate) {
    // Re-adding a goal the user had archived is a request to bring it back, not an error.
    if (!duplicate.active) {
      const [revived] = await db
        .update(userGoals)
        .set({ active: 1 })
        .where(eq(userGoals.id, duplicate.id))
        .returning();
      revalidatePath("/settings");
      revalidatePath("/graph");
      return revived;
    }
    return duplicate;
  }

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

export async function deleteGoal(id: string) {
  const userId = await requireUserId();
  const db = await getDb();
  await db
    .delete(userGoals)
    .where(and(eq(userGoals.id, id), eq(userGoals.userId, userId)));

  revalidatePath("/settings");
  revalidatePath("/graph");
  revalidatePath("/contacts");
  revalidatePath("/dashboard");
}
