"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { ensureUserSettings } from "@/lib/user-settings";
import { z } from "zod";
import { defineAction } from "@/lib/input/action";

const MAX_NOTIFIED_IDS = 200;

function trimIds(ids: string[]) {
  return [...new Set(ids.filter(Boolean))].slice(-MAX_NOTIFIED_IDS);
}

/** Ids already delivered as desktop notifications for this account. */
export const getDesktopNotifiedIds = defineAction(
  {},
  async (userId): Promise<string[]> => {
    const settings = await ensureUserSettings(userId);
    return trimIds(settings.desktopNotifiedIds ?? []);
  }
);

/** Merge ids into the account's delivered-notification list (bounded). */
export const mergeDesktopNotifiedIds = defineAction(
  { schema: z.tuple([z.array(z.string())]) },
  async (userId, ids: string[]): Promise<string[]> => mergeDesktopNotifiedIdsFor(userId, ids)
);

async function mergeDesktopNotifiedIdsFor(userId: string, ids: string[]): Promise<string[]> {
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

export const markDesktopNotificationsSent = defineAction(
  { schema: z.tuple([z.array(z.string())]) },
  async (userId, ids: string[]) => {
    if (ids.length === 0) return;
    await mergeDesktopNotifiedIdsFor(userId, ids);
  }
);

/**
 * Record whether this account wants desktop notifications. Every signed-in tab picks the
 * value up on its next app pulse, so turning them off on a laptop quiets the desktop too.
 */
export const setDesktopNotificationsEnabled = defineAction(
  { schema: z.tuple([z.boolean()]) },
  async (userId, enabled: boolean) => {
    const db = await getDb();
    await db
      .insert(userSettings)
      .values({ userId, desktopNotificationsEnabled: enabled })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { desktopNotificationsEnabled: enabled, updatedAt: new Date() },
      });
  }
);
