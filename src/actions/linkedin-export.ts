"use server";

import {
  claimLinkedInReminderFor,
  markLinkedInExportRequestedFor,
} from "@/lib/linkedin-reminder";
import { defineAction } from "@/lib/input/action";

/**
 * "I've requested it" from onboarding's LinkedIn step. Opening LinkedIn's page does not
 * call this — only the confirmation does, so the reminder's "you asked LinkedIn a day ago"
 * copy is never built on a click that went nowhere.
 */
export const markLinkedInExportRequested = defineAction(
  {},
  async (userId): Promise<{ requestedAt: string }> => {
    const requestedAt = await markLinkedInExportRequestedFor(userId);
    return { requestedAt: requestedAt.toISOString() };
  }
);

/**
 * The reminder watcher's one call: true means this tab takes the account's single showing.
 * The server re-checks eligibility, so a stale `due` prop can never replay it.
 */
export const claimLinkedInReminder = defineAction(
  {},
  async (userId): Promise<{ claimed: boolean }> => {
    return { claimed: await claimLinkedInReminderFor(userId) };
  }
);
