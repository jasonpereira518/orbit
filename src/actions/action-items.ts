"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { setActionItemStatusForUser } from "@/lib/action-items";
import { completeReminder } from "@/lib/reminders";
import { revalidateReminderPaths } from "@/lib/reminder-paths";

export async function setActionItemStatus(id: string, status: "open" | "done") {
  const userId = await requireUserId();
  const row = await setActionItemStatusForUser(userId, id, status);
  if (!row) throw new Error("Action item not found");
  if (status === "done" && row.reminderId) await completeReminder(userId, row.reminderId);
  revalidateReminderPaths(row.contactId);
  revalidatePath(`/contacts/${row.contactId}`);
  return row;
}
