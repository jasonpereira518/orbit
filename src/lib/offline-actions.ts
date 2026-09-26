"use client";

import {
  markReminderDone,
  rescheduleReminderAction,
  snoozeReminderAction,
} from "@/actions/reminders";
import type { OfflineRunners } from "@/lib/offline-queue-store";

/**
 * How each queueable kind is sent. One entry per `OFFLINE_ACTION_KINDS`; the type makes a
 * missing one a compile error.
 *
 * Kept apart from `offline-queue-store.ts` so the store (imported by `toast.tsx`, so by every
 * page) does not pull Server Action references into bundles that never replay anything.
 * Only `OfflineSync` imports this.
 */
export const OFFLINE_RUNNERS: OfflineRunners = {
  "reminder.done": ({ args: [reminderId] }) => markReminderDone(reminderId),
  // Snooze counts days from when it is SENT, so a week's snooze queued this morning and sent
  // tonight lands tonight-plus-a-week. Hours of drift on a week is harmless for the one-click
  // "snooze a week" buttons; the reminders page's day picker queues `reminder.reschedule`,
  // which is absolute.
  "reminder.snooze": ({ args: [reminderId, days] }) => snoozeReminderAction(reminderId, days),
  "reminder.reschedule": ({ args: [reminderId, ymd] }) => rescheduleReminderAction(reminderId, ymd),
};
