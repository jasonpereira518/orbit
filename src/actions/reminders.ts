"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { reminders } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  completeReminder,
  getDashboardData,
  snoozeReminder,
} from "@/lib/reminders";

export async function fetchDashboard() {
  const userId = await requireUserId();
  return getDashboardData(userId);
}

export async function createReminder(input: {
  contactId?: string;
  title: string;
  description?: string;
  dueDate?: string;
  reminderType?: string;
}) {
  const userId = await requireUserId();
  const db = await getDb();
  const [row] = await db
    .insert(reminders)
    .values({
      userId,
      contactId: input.contactId,
      title: input.title,
      description: input.description,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      reminderType: input.reminderType || "manual",
      createdBy: "user",
      status: "pending",
    })
    .returning();

  revalidatePath("/");
  if (input.contactId) revalidatePath(`/contacts/${input.contactId}`);
  return row;
}

export async function markReminderDone(id: string) {
  const userId = await requireUserId();
  await completeReminder(userId, id);
  revalidatePath("/");
}

export async function snoozeReminderAction(id: string, days = 7) {
  const userId = await requireUserId();
  await snoozeReminder(userId, id, days);
  revalidatePath("/");
}

export async function dismissSuggestion(id: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const { aiSuggestions } = await import("@/db/schema");
  await db
    .update(aiSuggestions)
    .set({ status: "dismissed" })
    .where(and(eq(aiSuggestions.id, id), eq(aiSuggestions.userId, userId)));
  revalidatePath("/");
}
