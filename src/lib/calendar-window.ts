/**
 * The user's `calendar_events` window, re-read now — for the app pulse, so a meeting added or
 * cancelled since the last scheduled sync (every 30 minutes, often later) reaches the prep card
 * and record nudge. Every enabled calendar (Google, Outlook, iCloud) through the same readers
 * the scheduler uses. Its own module because it reaches every provider's credentials, which
 * `calendar-events.ts` (imported by those providers' own modules) must not.
 */
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appleConnections, calendarSources, gmailConnections, outlookConnections } from "@/db/schema";
import { eventsWindow, refreshCalendarWindow } from "@/lib/calendar-events";
import * as google from "@/lib/connectors/google-calendar";
import * as microsoft from "@/lib/connectors/microsoft-calendar";
import * as apple from "@/lib/connectors/apple-calendar";
import { getValidAccessToken as getGoogleToken, hasCalendarScope as hasGoogleCalendar } from "@/lib/gmail";
import { getValidAccessToken as getOutlookToken, hasCalendarScope as hasOutlookCalendar } from "@/lib/outlook";
import { appleCredentials } from "@/lib/apple";
import { ReauthRequiredError } from "@/lib/errors";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import type { StoredCalendarEvent } from "@/lib/connectors/google-calendar";

export type WindowDeps = {
  getGoogleToken?: typeof getGoogleToken;
  fetchGoogleWindow?: typeof google.fetchCalendarWindow;
  getOutlookToken?: typeof getOutlookToken;
  fetchOutlookWindow?: typeof microsoft.fetchCalendarWindow;
  getAppleCredentials?: typeof appleCredentials;
  fetchAppleWindow?: typeof apple.fetchCalendarWindow;
};

type Source = typeof calendarSources.$inferSelect;
type Read = { events: StoredCalendarEvent[]; complete: boolean };

/** One calendar's window, or null when its connection can't be read right now. */
async function readSource(userId: string, source: Source, from: Date, to: Date, deps: WindowDeps): Promise<Read | null> {
  const db = await getDb();
  if (source.provider === "google") {
    const conn = await db.query.gmailConnections.findFirst({ where: eq(gmailConnections.id, source.connectionId) });
    if (!conn || conn.status !== "active" || !hasGoogleCalendar(conn.scopes)) return null;
    const accessToken = await (deps.getGoogleToken ?? getGoogleToken)(userId);
    const read = await (deps.fetchGoogleWindow ?? google.fetchCalendarWindow)({ accessToken, from, to, maxPages: 4, timeoutMs: 10_000 });
    return { events: google.storedEventsOf(read.items), complete: read.complete };
  }
  if (source.provider === "microsoft") {
    const conn = await db.query.outlookConnections.findFirst({ where: eq(outlookConnections.id, source.connectionId) });
    if (!conn || conn.status !== "active" || !hasOutlookCalendar(conn.scopes)) return null;
    const accessToken = await (deps.getOutlookToken ?? getOutlookToken)(userId);
    const read = await (deps.fetchOutlookWindow ?? microsoft.fetchCalendarWindow)({ accessToken, from, to, maxPages: 4, timeoutMs: 10_000 });
    return { events: microsoft.storedEventsOf(read.items, conn.emailAddress), complete: read.complete };
  }
  const conn = await db.query.appleConnections.findFirst({ where: eq(appleConnections.id, source.connectionId) });
  if (!conn || conn.status !== "active") return null;
  const creds = await (deps.getAppleCredentials ?? appleCredentials)(conn.id);
  const events = await (deps.fetchAppleWindow ?? apple.fetchCalendarWindow)({
    creds,
    calendarUrl: source.calendarId,
    ownerEmail: conn.emailAddress,
    from,
    to,
  });
  return { events, complete: true };
}

// ponytail: per-instance Map, never pruned — one entry per active user, fine at this size.
const recentTries = new Map<string, number>();

/**
 * Re-read every enabled calendar's window. At most once per user per ten minutes: the pulse
 * calls this every 90 seconds per tab, so an instance that tried lately skips even the bucket
 * write, and the bucket keeps instances (and tabs) from stacking reads. A throttled call is
 * "fresh enough" and does nothing. One calendar failing never stops the others.
 */
export async function refreshUserCalendarWindows(
  userId: string,
  now: Date,
  deps: WindowDeps = {}
): Promise<{ refreshed: number }> {
  const last = recentTries.get(userId);
  if (last !== undefined && now.getTime() - last < RATE_LIMITS.calendarWindow.windowSec * 1000) return { refreshed: 0 };
  recentTries.set(userId, now.getTime());
  try {
    await consumeBucket("calendarWindow", userId, RATE_LIMITS.calendarWindow);
  } catch (err) {
    if (isRateLimitedError(err)) return { refreshed: 0 };
    throw err;
  }
  const db = await getDb();
  // Only sources the scheduler already made: creating one is the sync's job.
  const sources = await db
    .select()
    .from(calendarSources)
    .where(and(eq(calendarSources.userId, userId), eq(calendarSources.enabled, 1)))
    .orderBy(asc(calendarSources.createdAt));
  const { from, to } = eventsWindow(now);
  let refreshed = 0;
  for (const source of sources) {
    try {
      const read = await readSource(userId, source, from, to, deps);
      if (!read) continue;
      await refreshCalendarWindow(userId, source.id, read, now);
      refreshed++;
    } catch (err) {
      // Needs reconnecting: Settings says so; the pulse has nothing to add.
      if (err instanceof ReauthRequiredError) continue;
      reportError(err, { where: "pulse.calendar-window", userId, level: "warning", extra: { provider: source.provider } });
    }
  }
  return { refreshed };
}
