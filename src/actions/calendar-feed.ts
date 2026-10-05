"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { ensureUserSettings } from "@/lib/user-settings";
import { buildCalendarFeedUrl, buildCalendarFeedWebcalUrl, clearCalendarFeedToken, mintCalendarFeedToken } from "@/lib/calendar-feed";

export type CalendarFeedStatus = {
  enabled: boolean;
  /** The feed URLs exist only in the response that minted the token; Orbit stores a hash. */
  url: string | null;
  webcalUrl: string | null;
  googleAddUrl: string | null;
  outlookLiveAddUrl: string | null;
  outlookOfficeAddUrl: string | null;
  createdAt: Date | null;
  lastFetchedAt: Date | null;
};

type FeedRow = {
  calendarFeedToken: string | null;
  calendarFeedTokenCreatedAt: Date | null;
  calendarFeedLastFetchedAt: Date | null;
};

function toStatus(row: FeedRow, freshToken: string | null): CalendarFeedStatus {
  if (!row.calendarFeedToken) {
    return {
      enabled: false,
      url: null,
      webcalUrl: null,
      googleAddUrl: null,
      outlookLiveAddUrl: null,
      outlookOfficeAddUrl: null,
      createdAt: null,
      lastFetchedAt: null,
    };
  }
  const webcalUrl = freshToken ? buildCalendarFeedWebcalUrl(freshToken) : null;
  const encoded = webcalUrl ? encodeURIComponent(webcalUrl) : null;
  return {
    enabled: true,
    url: freshToken ? buildCalendarFeedUrl(freshToken) : null,
    webcalUrl,
    googleAddUrl: webcalUrl ? `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}` : null,
    // Two hosts, because Microsoft has two and nothing here says which this person uses.
    // Guessing wrong fails silently, so both are offered rather than one picked.
    outlookLiveAddUrl: encoded
      ? `https://outlook.live.com/calendar/0/addfromweb?url=${encoded}&name=Orbit%20reminders`
      : null,
    outlookOfficeAddUrl: encoded
      ? `https://outlook.office.com/calendar/0/addfromweb?url=${encoded}&name=Orbit%20reminders`
      : null,
    createdAt: row.calendarFeedTokenCreatedAt,
    lastFetchedAt: row.calendarFeedLastFetchedAt,
  };
}

async function readSettings(userId: string): Promise<FeedRow> {
  const db = await getDb();
  await ensureUserSettings(userId);
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { calendarFeedToken: true, calendarFeedTokenCreatedAt: true, calendarFeedLastFetchedAt: true },
  });
  return row ?? { calendarFeedToken: null, calendarFeedTokenCreatedAt: null, calendarFeedLastFetchedAt: null };
}

export async function getCalendarFeedStatus(): Promise<CalendarFeedStatus> {
  const userId = await requireUserId();
  return toStatus(await readSettings(userId), null);
}

/** Minted only on request — never in ensureUserSettings. Don't issue unasked-for creds. */
export async function enableCalendarFeed(): Promise<CalendarFeedStatus> {
  const userId = await requireUserId();
  const existing = await readSettings(userId);
  if (existing.calendarFeedToken) return toStatus(existing, null);
  const token = await mintCalendarFeedToken(userId);
  return toStatus(await readSettings(userId), token);
}

/** Revokes immediately: the previous URL starts 404ing on the next poll. */
export async function regenerateCalendarFeedToken(): Promise<CalendarFeedStatus> {
  const userId = await requireUserId();
  await ensureUserSettings(userId);
  const token = await mintCalendarFeedToken(userId);
  return toStatus(await readSettings(userId), token);
}

export async function disableCalendarFeed(): Promise<CalendarFeedStatus> {
  const userId = await requireUserId();
  await ensureUserSettings(userId);
  await clearCalendarFeedToken(userId);
  return toStatus(await readSettings(userId), null);
}
