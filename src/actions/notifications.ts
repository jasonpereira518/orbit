"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { ensureUserSettings } from "@/lib/user-settings";

const MAX_NOTIFIED_IDS = 200;

function trimIds(ids: string[]) {
  return [...new Set(ids.filter(Boolean))].slice(-MAX_NOTIFIED_IDS);
}

/** Ids already delivered as desktop notifications for this account. */
export async function getDesktopNotifiedIds(): Promise<string[]> {
  const userId = await requireUserId();
  const settings = await ensureUserSettings(userId);
  return trimIds(settings.desktopNotifiedIds ?? []);
}

/** Merge ids into the account's delivered-notification list (bounded). */
export async function mergeDesktopNotifiedIds(ids: string[]): Promise<string[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const settings = await ensureUserSettings(userId);
  const merged = trimIds([...(settings.desktopNotifiedIds ?? []), ...ids]);

  await db
    .update(userSettings)
    .set({
      desktopNotifiedIds: merged,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId));

  return merged;
}

export async function markDesktopNotificationsSent(ids: string[]) {
  if (ids.length === 0) return;
  await mergeDesktopNotifiedIds(ids);
}
