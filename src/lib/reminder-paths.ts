import { revalidatePath } from "next/cache";

/**
 * The routes that render reminder state. Shared rather than duplicated so the set can't
 * drift between the reminders actions and the suggested-reminders actions.
 *
 * Lives outside `src/actions/` because those modules are `"use server"`, where every
 * export must be an async function.
 */
export function revalidateReminderPaths(contactId?: string | null) {
  revalidatePath("/");
  revalidatePath("/dashboard");
  revalidatePath("/reminders");
  if (contactId) {
    revalidatePath(`/contacts/${contactId}`);
    revalidatePath("/graph");
  }
}
