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
import {
  LINKEDIN_ARCHIVE_SEARCH,
  linkedInArchiveSearch,
} from "@/lib/inbox-search";
import { LINKEDIN_IMPORT_TYPE } from "@/lib/import-adapters/linkedin-connections";
import { LINKEDIN_MESSAGES_IMPORT_TYPE } from "@/lib/import-adapters/linkedin-messages";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The reminder's wording, hoisted so the insert and the refresh below cannot drift.
 * It names the inbox first because that is the actual blocker a day later: the export
 * link arrives by email, and "find one email from yesterday" is where people stall.
 */
const REMINDER_TITLE = "Check your email for your LinkedIn export";
const REMINDER_DESCRIPTION = `LinkedIn emails a download link within about a day. Search your inbox for \u201C${LINKEDIN_ARCHIVE_SEARCH}\u201D, download the ZIP, then upload it in Imports.`;

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
    // Idempotent on the row, not on its wording: a reminder created before the inbox
    // search existed still says only "open Imports", which leaves the person holding it
    // with the exact problem the search link was added to solve. The due date and status
    // are left alone — this refreshes the instructions, it does not reschedule anything.
    if (
      existing.title !== REMINDER_TITLE ||
      existing.description !== REMINDER_DESCRIPTION
    ) {
      await db
        .update(reminders)
        .set({ title: REMINDER_TITLE, description: REMINDER_DESCRIPTION })
        .where(eq(reminders.id, existing.id));
    }
  } else {
    const listId = await getInboxListId(userId);
    dueDate = new Date(Date.now() + ONE_DAY_MS);

    const [row] = await db
      .insert(reminders)
      .values({
        userId,
        listId,
        title: REMINDER_TITLE,
        description: REMINDER_DESCRIPTION,
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
  inboxSearchUrl: string;
  inboxSearchLabel: string;
}> {
  const userId = await requireUserId();
  const settings = await ensureUserSettings(userId);

  // Resolved here rather than at each mount point: both callers (the dashboard and
  // /imports) already await this, and the address it depends on is on the row this
  // function has already loaded, so the link costs nothing extra and cannot drift
  // between the two surfaces.
  const search = linkedInArchiveSearch(settings.email);

  // Nothing was ever requested — there's no nudge to retire and no reminder that could be
  // pending, so the `imports` lookup below (this is called on every dashboard/imports render)
  // would only spend a query to reconfirm `false`.
  if (!settings.linkedinExportRequestedAt) {
    return {
      requestedAt: null,
      hasLinkedInImport: false,
      inboxSearchUrl: search.url,
      inboxSearchLabel: search.label,
    };
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
    inboxSearchUrl: search.url,
    inboxSearchLabel: search.label,
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
