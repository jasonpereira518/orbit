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
