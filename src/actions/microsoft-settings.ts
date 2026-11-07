"use server";

import { and, count, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarSources, cloudNoteFiles, cloudNoteSources, contacts, interactions, outlookConnections } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { getValidAccessToken } from "@/lib/outlook";
import { listMicrosoftCalendars, MICROSOFT_DEFAULT_CALENDAR_ID } from "@/lib/connectors/microsoft-calendar";
import { setSourceEnabled } from "@/lib/calendar-sources";
import { reportError } from "@/lib/report-error";
import { UserFacingError } from "@/lib/errors";

export type MicrosoftCalendarRow = {
  id: string;
  calendarId: string;
  name: string;
  color: string | null;
  enabled: boolean;
  primary: boolean;
  lastSyncedAt: Date | null;
};

export type MicrosoftPanel = {
  /** People from Outlook: the background sync (`microsoft_contacts`) and one-shot imports. */
  contactsFromOutlook: number;
  meetingsLogged: number;
  /** When background contacts sync last finished a pass, or null. */
  contactsSyncedAt: string | null;
  calendars: MicrosoftCalendarRow[];
  /** Null when OneDrive isn't being watched (no Files.Read, or never connected with it). */
  oneDrive: { lastScanAt: Date | null; lastError: string | null; notesFound: number } | null;
};

const EMPTY: MicrosoftPanel = { contactsFromOutlook: 0, meetingsLogged: 0, contactsSyncedAt: null, calendars: [], oneDrive: null };

/** The Microsoft page's counts, calendars and OneDrive watch, in one read. Connection state stays with `useMicrosoftConnection`. */
export async function getMicrosoftPanel(): Promise<MicrosoftPanel> {
  const userId = await requireUserId();
  const db = await getDb();
  const conn = await db.query.outlookConnections.findFirst({
    where: eq(outlookConnections.userId, userId),
    columns: { id: true, syncCursor: true },
  });
  if (!conn) return EMPTY;
  const [[people], [meetings], sources, drive, [notes]] = await Promise.all([
    db
      .select({ n: count() })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), inArray(contacts.source, ["microsoft_contacts", "outlook_contacts"]))),
    db
      .select({ n: count() })
      .from(interactions)
      .where(and(eq(interactions.userId, userId), eq(interactions.source, "microsoft_calendar"))),
    db
      .select()
      .from(calendarSources)
      .where(and(eq(calendarSources.userId, userId), eq(calendarSources.connectionId, conn.id))),
    db.query.cloudNoteSources.findFirst({
      where: and(eq(cloudNoteSources.userId, userId), eq(cloudNoteSources.provider, "microsoft")),
      columns: { lastScanAt: true, lastError: true },
    }),
    db
      .select({ n: count() })
      .from(cloudNoteFiles)
      .where(
        and(
          eq(cloudNoteFiles.userId, userId),
          eq(cloudNoteFiles.provider, "microsoft"),
          inArray(cloudNoteFiles.status, ["found", "queued"]),
        ),
      ),
  ]);
  return {
    contactsFromOutlook: Number(people?.n ?? 0),
    meetingsLogged: Number(meetings?.n ?? 0),
    contactsSyncedAt: conn.syncCursor?.contactsSyncedAt ?? null,
    calendars: sources.map(toRow).sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name)),
    oneDrive: drive ? { lastScanAt: drive.lastScanAt, lastError: drive.lastError, notesFound: Number(notes?.n ?? 0) } : null,
  };
}

function toRow(s: typeof calendarSources.$inferSelect): MicrosoftCalendarRow {
  const primary = s.calendarId === MICROSOFT_DEFAULT_CALENDAR_ID;
  return {
    id: s.id,
    calendarId: s.calendarId,
    name: s.displayName ?? (primary ? "Your calendar" : "Calendar"),
    color: s.color,
    enabled: s.enabled !== 0,
    primary,
    lastSyncedAt: s.lastSyncedAt,
  };
}

/**
 * Ask Graph which calendars this account has and record each as a `calendar_sources` row.
 * New calendars start off; an existing row keeps its switch and only follows Outlook's name
 * and colour.
 */
export async function refreshMicrosoftCalendars(): Promise<MicrosoftCalendarRow[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const conn = await db.query.outlookConnections.findFirst({
    where: eq(outlookConnections.userId, userId),
    columns: { id: true, status: true },
  });
  if (!conn || conn.status !== "active") throw new UserFacingError("Connect Outlook first");
  let calendars;
  try {
    calendars = await listMicrosoftCalendars({ accessToken: await getValidAccessToken(userId) });
  } catch (err) {
    reportError(err, { where: "action.microsoft.calendars", userId, level: "warning" });
    throw new UserFacingError("Outlook didn’t list your calendars — try again in a moment");
  }
  for (const c of calendars) {
    await db
      .insert(calendarSources)
      .values({
        userId,
        provider: "microsoft",
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
  return (await getMicrosoftPanel()).calendars;
}

/** Read this calendar or not. The next sync picks it up (or stops reading it). */
export async function setMicrosoftCalendarEnabled(sourceId: string, enabled: boolean): Promise<void> {
  const userId = await requireUserId();
  if (typeof sourceId !== "string" || !/^[0-9a-f-]{36}$/i.test(sourceId)) throw new UserFacingError("Pick a calendar");
  await setSourceEnabled(userId, sourceId, enabled);
  if (enabled) {
    const db = await getDb();
    await db
      .update(outlookConnections)
      .set({ nextSyncAt: new Date(), updatedAt: new Date() })
      .where(and(eq(outlookConnections.userId, userId), eq(outlookConnections.status, "active")));
  }
}
