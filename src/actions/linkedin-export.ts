"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getDb } from "@/db";
import { imports, reminders, userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { ensureUserSettings } from "@/lib/user-settings";
import { getInboxListId } from "@/lib/reminder-lists";
import { revalidateReminderPaths } from "@/lib/reminder-paths";
import { retireLinkedInExportReminders } from "@/lib/linkedin-export";
import { LINKEDIN_IMPORT_TYPE } from "@/lib/import-adapters/linkedin-connections";
import { LINKEDIN_MESSAGES_IMPORT_TYPE } from "@/lib/import-adapters/linkedin-messages";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stamps `linkedin_export_requested_at` the first time the user requests an export.
 * Idempotent — a second call (e.g. from "Remind me tomorrow" after "Request export" was
 * already clicked) returns the original stamp rather than pushing it forward, so the
 * 30-day nudge window and the reminder's "requested {date}" copy both read as one event.
 */
export async function markLinkedInExportRequested(): Promise<{
  requestedAt: string;
}> {
  const userId = await requireUserId();
  const db = await getDb();
  const settings = await ensureUserSettings(userId);

  if (settings.linkedinExportRequestedAt) {
    return {
      requestedAt: new Date(settings.linkedinExportRequestedAt).toISOString(),
    };
  }

  const requestedAt = new Date();
  await db
    .update(userSettings)
    .set({ linkedinExportRequestedAt: requestedAt, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));

  return { requestedAt: requestedAt.toISOString() };
}

/**
 * Creates (or returns) the "upload your LinkedIn export" reminder, due 24h out.
 * Idempotent on the pending `linkedin_export` reminder rather than on a fixed key, since
 * reminders have no unique constraint to upsert against and a second click of "Remind me
 * tomorrow" must not spawn a duplicate task in the inbox.
 */
export async function scheduleLinkedInExportReminder(): Promise<{
  reminderId: string;
  dueDate: string;
}> {
  const userId = await requireUserId();
  const db = await getDb();

  const existing = await db.query.reminders.findFirst({
    where: and(
      eq(reminders.userId, userId),
      eq(reminders.reminderType, "linkedin_export"),
      eq(reminders.status, "pending")
    ),
  });

  let reminderId: string;
  let dueDate: Date;

  if (existing) {
    reminderId = existing.id;
    dueDate = existing.dueDate ? new Date(existing.dueDate) : new Date();
  } else {
    const listId = await getInboxListId(userId);
    dueDate = new Date(Date.now() + ONE_DAY_MS);

    const [row] = await db
      .insert(reminders)
      .values({
        userId,
        listId,
        title: "Upload your LinkedIn export to Orbit",
        description:
          "LinkedIn emails a download link within about a day. Open Imports and drop the ZIP in.",
        dueDate,
        reminderType: "linkedin_export",
        actionKind: "task",
        createdBy: "user",
        status: "pending",
      })
      .returning();
    reminderId = row.id;
  }

  await markLinkedInExportRequested();

  revalidateReminderPaths();
  revalidatePath("/imports");

  return { reminderId, dueDate: dueDate.toISOString() };
}

/**
 * `hasLinkedInImport` covers both the connections CSV and the messages archive — either
 * one satisfies "the export arrived and was uploaded", which is what should retire the
 * nudge and the reminder alike.
 */
export async function getLinkedInExportStatus(): Promise<{
  requestedAt: string | null;
  hasLinkedInImport: boolean;
}> {
  const userId = await requireUserId();
  const settings = await ensureUserSettings(userId);

  // Nothing was ever requested — there's no nudge to retire and no reminder that could be
  // pending, so the `imports` lookup below (this is called on every dashboard/imports render)
  // would only spend a query to reconfirm `false`.
  if (!settings.linkedinExportRequestedAt) {
    return { requestedAt: null, hasLinkedInImport: false };
  }

  const db = await getDb();
  const importRow = await db.query.imports.findFirst({
    where: and(
      eq(imports.userId, userId),
      inArray(imports.importType, [
        LINKEDIN_IMPORT_TYPE,
        LINKEDIN_MESSAGES_IMPORT_TYPE,
      ])
    ),
  });
  const hasLinkedInImport = Boolean(importRow);

  // Covers imports that predate this fix — `startLinkedInImport`/`startLinkedInMessagesImport`
  // retire the reminder themselves going forward, but a user who uploaded before this shipped
  // would otherwise carry a "done" import next to a permanently pending reminder.
  //
  // Deferred via `after()`, not run inline: this is called directly from the dashboard's and
  // /imports's Server Component render (`StatsSection`, `ImportsPage`), and `revalidatePath`
  // throws when called during render — same reason `imports/page.tsx` wraps
  // `syncStaleCalendarSubscriptions` (which also revalidates) in `after()` at its call site.
  if (hasLinkedInImport) {
    after(() =>
      retireLinkedInExportReminders(userId)
        .then(() => revalidateReminderPaths())
        .catch(() => {})
    );
  }

  return {
    requestedAt: new Date(settings.linkedinExportRequestedAt).toISOString(),
    hasLinkedInImport,
  };
}

/** Dismisses the dashboard/imports nudge by clearing the stamp. */
export async function dismissLinkedInExportNudge(): Promise<void> {
  const userId = await requireUserId();
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({ linkedinExportRequestedAt: null, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));

  revalidatePath("/imports");
  revalidatePath("/dashboard");
}
