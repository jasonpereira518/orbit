import { cache } from "react";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { imports, userSettings } from "@/db/schema";
import { LINKEDIN_IMPORT_TYPE } from "@/lib/import-adapters/linkedin-connections";
import { LINKEDIN_MESSAGES_IMPORT_TYPE } from "@/lib/import-adapters/linkedin-messages";
import {
  LINKEDIN_REMINDER_MAX_AGE_MS,
  LINKEDIN_REMINDER_MIN_AGE_MS,
  isLinkedInNudgeVisible,
  isLinkedInReminderDue,
  isLinkedInReminderWindowOpen,
} from "@/lib/linkedin-export";
import { ensureUserSettings } from "@/lib/user-settings";

/**
 * The database half of the LinkedIn export reminder — see `src/lib/linkedin-export.ts` for
 * the rules. No `next/*` imports: the smoke script calls these directly.
 */

type ReminderSettings = {
  createdAt: Date;
  linkedinReminderShownAt: Date | null;
  linkedinExportRequestedAt: Date | null;
};

/**
 * Either LinkedIn upload counts. Both come out of the same archive, so a messages import
 * is proof the email arrived — asking "is your export ready?" after that would be noise.
 */
export const hasLinkedInImport = cache(async (userId: string): Promise<boolean> => {
  const db = await getDb();
  const row = await db.query.imports.findFirst({
    where: and(
      eq(imports.userId, userId),
      inArray(imports.importType, [LINKEDIN_IMPORT_TYPE, LINKEDIN_MESSAGES_IMPORT_TYPE]),
    ),
    columns: { id: true },
  });
  return Boolean(row);
});

/**
 * What the app layout hands the reminder watcher. Costs no query outside the 24h–14d
 * window or once the reminder has been shown, which is every page load but a handful.
 */
export async function getLinkedInReminderState(
  userId: string,
  settings: ReminderSettings,
): Promise<{ due: boolean; requested: boolean }> {
  const requested = settings.linkedinExportRequestedAt != null;
  const now = new Date();
  const input = { createdAt: settings.createdAt, shownAt: settings.linkedinReminderShownAt, now };
  if (!isLinkedInReminderWindowOpen(input)) return { due: false, requested };
  const due = isLinkedInReminderDue({ ...input, hasLinkedInImport: await hasLinkedInImport(userId) });
  return { due, requested };
}

/**
 * Takes this account's one showing. True means "draw it"; false means another tab or
 * device already did, or the account is no longer eligible.
 *
 * The whole rule is restated in the UPDATE's WHERE clause rather than read-then-written,
 * so concurrent claims serialize on the row and exactly one sees `shown_at IS NULL`. The
 * import check stays a separate read — an upload landing in the gap between it and the
 * UPDATE shows the screen one last time, which is harmless.
 */
export async function claimLinkedInReminderFor(userId: string): Promise<boolean> {
  if (await hasLinkedInImport(userId)) return false;
  const db = await getDb();
  const now = new Date();
  const claimed = await db
    .update(userSettings)
    .set({ linkedinReminderShownAt: now, updatedAt: now })
    .where(
      and(
        eq(userSettings.userId, userId),
        isNull(userSettings.linkedinReminderShownAt),
        lte(userSettings.createdAt, new Date(now.getTime() - LINKEDIN_REMINDER_MIN_AGE_MS)),
        gte(userSettings.createdAt, new Date(now.getTime() - LINKEDIN_REMINDER_MAX_AGE_MS)),
      ),
    )
    .returning();
  return claimed.length > 0;
}

/**
 * Stamps "I've requested it". Write-once, in SQL, so a double click or a second tab cannot
 * move the time; returns whichever stamp stands.
 */
export async function markLinkedInExportRequestedFor(userId: string): Promise<Date> {
  await ensureUserSettings(userId);
  const db = await getDb();
  const now = new Date();
  const [stamped] = await db
    .update(userSettings)
    .set({ linkedinExportRequestedAt: now, updatedAt: now })
    .where(and(eq(userSettings.userId, userId), isNull(userSettings.linkedinExportRequestedAt)))
    .returning();
  if (stamped?.linkedinExportRequestedAt) return stamped.linkedinExportRequestedAt;

  const existing = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { linkedinExportRequestedAt: true },
  });
  return existing?.linkedinExportRequestedAt ?? now;
}

/** The dashboard card's verdict, with the same free-outside-the-window shape as above. */
export async function getLinkedInNudgeVisible(
  userId: string,
  settings: ReminderSettings,
): Promise<boolean> {
  const now = new Date();
  const base = {
    createdAt: settings.createdAt,
    shownAt: settings.linkedinReminderShownAt,
    requestedAt: settings.linkedinExportRequestedAt,
    now,
  };
  if (!isLinkedInNudgeVisible({ ...base, hasLinkedInImport: false })) return false;
  return isLinkedInNudgeVisible({ ...base, hasLinkedInImport: await hasLinkedInImport(userId) });
}
