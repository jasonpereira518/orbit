"use server";

import { requireUserId } from "@/lib/auth";
import {
  claimLinkedInReminderFor,
  markLinkedInExportRequestedFor,
} from "@/lib/linkedin-reminder";

/**
 * "I've requested it" from onboarding's LinkedIn step. Opening LinkedIn's page does not
 * call this — only the confirmation does, so the reminder's "you asked LinkedIn a day ago"
 * copy is never built on a click that went nowhere.
 */
export async function markLinkedInExportRequested(): Promise<{ requestedAt: string }> {
  const userId = await requireUserId();
  const requestedAt = await markLinkedInExportRequestedFor(userId);
  return { requestedAt: requestedAt.toISOString() };
}

/**
 * The reminder watcher's one call: true means this tab takes the account's single showing.
 * The server re-checks eligibility, so a stale `due` prop can never replay it.
 */
export async function claimLinkedInReminder(): Promise<{ claimed: boolean }> {
  const userId = await requireUserId();
  return { claimed: await claimLinkedInReminderFor(userId) };
}
