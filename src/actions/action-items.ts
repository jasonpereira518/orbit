"use server";

import { revalidatePath } from "next/cache";
import { setActionItemStatusForUser } from "@/lib/action-items";
import { completeReminder } from "@/lib/reminders";
import { revalidateReminderPaths } from "@/lib/reminder-paths";
import { z } from "zod";
import { defineAction } from "@/lib/input/action";

export const setActionItemStatus = defineAction(
  { schema: z.tuple([z.string(), z.enum(["open", "done"])]) },
  async (userId, id: string, status: "open" | "done") => {
    const row = await setActionItemStatusForUser(userId, id, status);
    if (!row) throw new Error("Action item not found");
    if (status === "done" && row.reminderId) await completeReminder(userId, row.reminderId);
    revalidateReminderPaths(row.contactId);
    revalidatePath(`/contacts/${row.contactId}`);
    return row;
  }
);
