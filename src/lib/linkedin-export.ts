import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { reminders } from "@/db/schema";

/**
 * Marks the user's pending "upload your LinkedIn export" reminder(s) done.
 *
 * Pure DB helper — no `next/*` imports — so both `"use server"` actions (`startLinkedInImport`,
 * `startLinkedInMessagesImport` in `@/actions/imports`, and `getLinkedInExportStatus` below)
 * and `tsx` smoke scripts can call it directly. Mirrors `completeReminder` in
 * `src/lib/reminders.ts` (`reminders` has no `completedAt` column — `status: "done"` is the
 * whole state change).
 *
 * Filters on `reminderType: "linkedin_export"` and `status: "pending"` rather than a single
 * row id: `scheduleLinkedInExportReminder` is idempotent on that pair, so there is at most one,
 * but this stays correct even if that ever changes.
 */
export async function retireLinkedInExportReminders(userId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(reminders)
    .set({ status: "done" })
    .where(
      and(
        eq(reminders.userId, userId),
        eq(reminders.reminderType, "linkedin_export"),
        eq(reminders.status, "pending")
      )
    );
}
