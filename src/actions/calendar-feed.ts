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
  hashCalendarFeedToken,
} from "@/lib/calendar-feed";

export type CalendarFeedLinks = {
  url: string;
  webcalUrl: string;
  googleAddUrl: string;
};

export type CalendarFeedStatus = {
  enabled: boolean;
  createdAt: Date | null;
  lastFetchedAt: Date | null;
  /**
   * The feed URL, for exactly one response: the one that just minted the token. Orbit
   * stores only its SHA-256 hash (see `calendarFeedTokenHash` in `schema.ts`), the same
   * scheme as API keys, so there is no plaintext left anywhere to re-display it from on a
   * later `getCalendarFeedStatus` call. Lose it and the only way back is "Regenerate link".
   */
  links: CalendarFeedLinks | null;
}

function linksFor(token: string): CalendarFeedLinks {
  const webcalUrl = buildCalendarFeedWebcalUrl(token);
  return {
    url: buildCalendarFeedUrl(token),
    webcalUrl,
    googleAddUrl: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}`,
  };
}

async function readSettings(userId: string) {
  const db = await getDb();
  await ensureUserSettings(userId);
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: {
      calendarFeedTokenHash: true,
      calendarFeedTokenCreatedAt: true,
      calendarFeedLastFetchedAt: true,
    },
  });
  return (
    row ?? {
      calendarFeedTokenHash: null,
      calendarFeedTokenCreatedAt: null,
      calendarFeedLastFetchedAt: null,
    }
  );
}

export async function getCalendarFeedStatus(): Promise<CalendarFeedStatus> {
  const userId = await requireUserId();
  const row = await readSettings(userId);
  return {
    enabled: Boolean(row.calendarFeedTokenHash),
    createdAt: row.calendarFeedTokenCreatedAt,
    lastFetchedAt: row.calendarFeedLastFetchedAt,
    links: null,
  };
}

async function writeToken(userId: string, token: string | null) {
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({
      calendarFeedTokenHash: token ? hashCalendarFeedToken(token) : null,
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
  // Already enabled: the raw token from whenever it was created is gone for good, so this
  // can only report status, not hand back a link — same as any other status read.
  if (existing.calendarFeedTokenHash) {
    return {
      enabled: true,
      createdAt: existing.calendarFeedTokenCreatedAt,
      lastFetchedAt: existing.calendarFeedLastFetchedAt,
      links: null,
    };
  }

  const token = generateCalendarFeedToken();
  await writeToken(userId, token);
  const row = await readSettings(userId);
  return {
    enabled: true,
    createdAt: row.calendarFeedTokenCreatedAt,
    lastFetchedAt: row.calendarFeedLastFetchedAt,
    links: linksFor(token),
  };
}

/** Revokes immediately: the previous URL starts 404ing on the next poll. */
export async function regenerateCalendarFeedToken(): Promise<CalendarFeedStatus> {
  const userId = await requireUserId();
  const token = generateCalendarFeedToken();
  await writeToken(userId, token);
  const row = await readSettings(userId);
  return {
    enabled: true,
    createdAt: row.calendarFeedTokenCreatedAt,
    lastFetchedAt: row.calendarFeedLastFetchedAt,
    links: linksFor(token),
  };
}

export async function disableCalendarFeed(): Promise<CalendarFeedStatus> {
  const userId = await requireUserId();
  await writeToken(userId, null);
  return { enabled: false, createdAt: null, lastFetchedAt: null, links: null };
}
