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
  // The snooze menus queue an absolute ISO instant, re-validated at replay: one that has gone
  // stale by the time it is sent is refused, not drifted. A legacy day count still counts from
  // when it is SENT. The reminders page's day picker queues `reminder.reschedule`.
  "reminder.snooze": ({ args: [reminderId, when] }) => snoozeReminderAction(reminderId, when),
  "reminder.reschedule": ({ args: [reminderId, ymd] }) => rescheduleReminderAction(reminderId, ymd),
};
