"use server";

import { and, count, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarSources, contacts, gmailConnections, interactions, userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { getValidAccessToken } from "@/lib/gmail";
import { listGoogleCalendars } from "@/lib/connectors/google-calendar";
import { setSourceEnabled } from "@/lib/calendar-sources";
import { reportError } from "@/lib/report-error";
import { UserFacingError } from "@/lib/errors";

export type GoogleCalendarRow = {
  id: string;
  calendarId: string;
  name: string;
  color: string | null;
  enabled: boolean;
  primary: boolean;
  lastSyncedAt: Date | null;
};

export type GooglePanel = {
  contactsFromGoogle: number;
  meetingsLogged: number;
  emailsLogged: number;
  /** When background contacts sync last finished a pass, or null. */
  contactsSyncedAt: string | null;
  /** `user_settings.email_activity_sync`: log emails with known contacts. */
  emailActivityOn: boolean;
  calendars: GoogleCalendarRow[];
};

const EMPTY: GooglePanel = {
  contactsFromGoogle: 0,
  meetingsLogged: 0,
  emailsLogged: 0,
  contactsSyncedAt: null,
  emailActivityOn: false,
  calendars: [],
};

/** The Google page's counts and calendars, in one read. Connection state stays with `useGoogleConnection`. */
export async function getGooglePanel(): Promise<GooglePanel> {
  const userId = await requireUserId();
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { id: true, syncCursor: true },
  });
  if (!conn) return EMPTY;
  const tally = (source: string) =>
    db
      .select({ n: count() })
      .from(interactions)
      .where(and(eq(interactions.userId, userId), eq(interactions.source, source)))
      .then(([r]) => Number(r?.n ?? 0));
  const [[people], meetingsLogged, emailsLogged, sources, settings] = await Promise.all([
    db
      .select({ n: count() })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.source, "google_contacts"))),
    tally("google_calendar"),
    tally("gmail_activity"),
    db
      .select()
      .from(calendarSources)
      .where(and(eq(calendarSources.userId, userId), eq(calendarSources.connectionId, conn.id))),
    db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId), columns: { emailActivitySync: true } }),
  ]);
  return {
    contactsFromGoogle: Number(people?.n ?? 0),
    meetingsLogged,
    emailsLogged,
    contactsSyncedAt: conn.syncCursor?.contactsSyncedAt ?? null,
    emailActivityOn: (settings?.emailActivitySync ?? 0) === 1,
    calendars: sources.map(toRow).sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name)),
  };
}

function toRow(s: typeof calendarSources.$inferSelect): GoogleCalendarRow {
  return {
    id: s.id,
    calendarId: s.calendarId,
    name: s.displayName ?? (s.calendarId === "primary" ? "Your calendar" : s.calendarId),
    color: s.color,
    enabled: s.enabled !== 0,
    primary: s.calendarId === "primary",
    lastSyncedAt: s.lastSyncedAt,
  };
}

/**
 * Ask Google which calendars this account can read and record each as a `calendar_sources`
 * row. New calendars start off — reading more of someone's calendars is their call — and an
 * existing row keeps its switch; only its name and color follow Google.
 */
export async function refreshGoogleCalendars(): Promise<GoogleCalendarRow[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { id: true, status: true },
  });
  if (!conn || conn.status !== "active") throw new UserFacingError("Connect Google first");
  let calendars;
  try {
    calendars = await listGoogleCalendars({ accessToken: await getValidAccessToken(userId) });
  } catch (err) {
    reportError(err, { where: "action.google.calendars", userId, level: "warning" });
    throw new UserFacingError("Google didn’t list your calendars — try again in a moment");
  }
  for (const c of calendars) {
    await db
      .insert(calendarSources)
      .values({
        userId,
        provider: "google",
        connectionId: conn.id,
        calendarId: c.id,
        displayName: c.summary,
        color: c.color,
        enabled: c.primary ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [calendarSources.connectionId, calendarSources.calendarId],
        set: { displayName: c.summary, color: c.color, updatedAt: new Date() },
      });
  }
  return (await getGooglePanel()).calendars;
}

/** Read this calendar or not. The next sync picks it up (or stops reading it). */
export async function setGoogleCalendarEnabled(sourceId: string, enabled: boolean): Promise<void> {
  const userId = await requireUserId();
  if (typeof sourceId !== "string" || !/^[0-9a-f-]{36}$/i.test(sourceId)) throw new UserFacingError("Pick a calendar");
  await setSourceEnabled(userId, sourceId, enabled);
  if (enabled) {
    const db = await getDb();
    await db
      .update(gmailConnections)
      .set({ nextSyncAt: new Date(), updatedAt: new Date() })
      .where(and(eq(gmailConnections.userId, userId), eq(gmailConnections.status, "active")));
  }
}
