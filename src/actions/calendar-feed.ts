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

/**
 * TEMPORARY DIAGNOSTIC. getCalendarFeedStatus hangs in production (>12s, reproducible
 * on retry) while other server actions against the same database succeed. Nothing was
 * logging, so Vercel's logs were silent and there was no way to tell which await stalls.
 *
 * Remove this once the stage is identified. Logs are one line per stage, prefixed for
 * filtering.
 */
async function timed<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    console.log(`[calendar-feed] ${stage} ok in ${Date.now() - started}ms`);
    return result;
  } catch (err) {
    console.log(
      `[calendar-feed] ${stage} FAILED in ${Date.now() - started}ms:`,
      err instanceof Error ? err.message : String(err)
    );
    throw err;
  }
}

async function readSettings(userId: string) {
  // getDb() runs the runtime migration (full DDL + alters) on a cold instance, so it is
  // a real suspect rather than a trivial accessor.
  const db = await timed("getDb", () => getDb());
  await timed("ensureUserSettings", () => ensureUserSettings(userId));
  const row = await timed("findFirst", () =>
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: {
        calendarFeedToken: true,
        calendarFeedTokenCreatedAt: true,
        calendarFeedLastFetchedAt: true,
      },
    })
  );
  return (
    row ?? {
      calendarFeedToken: null,
      calendarFeedTokenCreatedAt: null,
      calendarFeedLastFetchedAt: null,
    }
  );
}

export async function getCalendarFeedStatus(): Promise<CalendarFeedStatus> {
  const overall = Date.now();
  console.log("[calendar-feed] getCalendarFeedStatus start");
  // requireUserId covers Clerk auth() plus bootstrapAuthenticatedUser, which itself
  // calls ensureUserSettings — so the stall may already be here, before readSettings.
  const userId = await timed("requireUserId", () => requireUserId());
  const status = toStatus(await readSettings(userId));
  console.log(`[calendar-feed] total ${Date.now() - overall}ms`);
  return status;
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
