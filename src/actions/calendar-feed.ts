"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { ensureUserSettings } from "@/lib/user-settings";
import {
  buildCalendarFeedUrl,
  buildCalendarFeedWebcalUrl,
  generateCalendarFeedToken,
} from "@/lib/calendar-feed";

export type CalendarFeedStatus = {
  enabled: boolean;
  url: string | null;
  webcalUrl: string | null;
  googleAddUrl: string | null;
  createdAt: Date | null;
  lastFetchedAt: Date | null;
};

function toStatus(row: {
  calendarFeedToken: string | null;
  calendarFeedTokenCreatedAt: Date | null;
  calendarFeedLastFetchedAt: Date | null;
}): CalendarFeedStatus {
  if (!row.calendarFeedToken) {
    return {
      enabled: false,
      url: null,
      webcalUrl: null,
      googleAddUrl: null,
      createdAt: null,
      lastFetchedAt: null,
    };
  }
  const webcalUrl = buildCalendarFeedWebcalUrl(row.calendarFeedToken);
  return {
    enabled: true,
    url: buildCalendarFeedUrl(row.calendarFeedToken),
    webcalUrl,
    googleAddUrl: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}`,
    createdAt: row.calendarFeedTokenCreatedAt,
    lastFetchedAt: row.calendarFeedLastFetchedAt,
  };
}

async function readSettings(userId: string) {
  const db = await getDb();
  await ensureUserSettings(userId);
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: {
      calendarFeedToken: true,
      calendarFeedTokenCreatedAt: true,
      calendarFeedLastFetchedAt: true,
    },
  });
  return (
    row ?? {
      calendarFeedToken: null,
      calendarFeedTokenCreatedAt: null,
      calendarFeedLastFetchedAt: null,
    }
  );
}

export async function getCalendarFeedStatus(): Promise<CalendarFeedStatus> {
  const userId = await requireUserId();
  return toStatus(await readSettings(userId));
}

async function writeToken(userId: string, token: string | null) {
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({
      calendarFeedToken: token,
      calendarFeedTokenCreatedAt: token ? new Date() : null,
      calendarFeedLastFetchedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId));
}

/** Minted only on request — never in ensureUserSettings. Don't issue unasked-for creds. */
export async function enableCalendarFeed(): Promise<CalendarFeedStatus> {
  const userId = await requireUserId();
  const existing = await readSettings(userId);
  if (existing.calendarFeedToken) return toStatus(existing);

  await writeToken(userId, generateCalendarFeedToken());
  return toStatus(await readSettings(userId));
}

/** Revokes immediately: the previous URL starts 404ing on the next poll. */
export async function regenerateCalendarFeedToken(): Promise<CalendarFeedStatus> {
  const userId = await requireUserId();
  await writeToken(userId, generateCalendarFeedToken());
  return toStatus(await readSettings(userId));
}

export async function disableCalendarFeed(): Promise<CalendarFeedStatus> {
  const userId = await requireUserId();
  await writeToken(userId, null);
  return toStatus(await readSettings(userId));
}
