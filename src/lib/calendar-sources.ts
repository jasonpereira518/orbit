/**
 * Reading and seeding `calendar_sources`.
 *
 * `seedCalendarSources` is the migration: it is idempotent (the unique index does the work)
 * and runs on every sync pass, so a connection made before this shipped gains its row the
 * first time it is claimed — and carries its existing cursor across, so nobody pays for a
 * full resync.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarSources, gmailConnections, outlookConnections } from "@/db/schema";
import type { CalendarSyncCursor } from "@/db/schema";

export type CalendarSourceRow = typeof calendarSources.$inferSelect;

/**
 * Seeds one `calendar_sources` row per existing Google/Outlook connection this user has,
 * carrying over whatever cursor already sits on the connection's `syncCursor.calendar` so a
 * connection that already synced does not pay for a full resync the first time it is claimed.
 *
 * `onConflictDoNothing` (on `calendar_sources_conn_cal_uidx`) is the whole idempotency
 * mechanism — a second call, or two concurrent callers, insert nothing new.
 */
export async function seedCalendarSources(userId: string): Promise<void> {
  const db = await getDb();

  const [google, outlook] = await Promise.all([
    db
      .select({ id: gmailConnections.id, syncCursor: gmailConnections.syncCursor })
      .from(gmailConnections)
      .where(eq(gmailConnections.userId, userId)),
    db
      .select({ id: outlookConnections.id, syncCursor: outlookConnections.syncCursor })
      .from(outlookConnections)
      .where(eq(outlookConnections.userId, userId)),
  ]);

  const rows = [
    ...google.map((c) => ({
      userId,
      provider: "google" as const,
      connectionId: c.id,
      calendarId: "primary",
      syncCursor: c.syncCursor?.calendar ?? null,
    })),
    ...outlook.map((c) => ({
      userId,
      provider: "microsoft" as const,
      connectionId: c.id,
      calendarId: "default",
      syncCursor: c.syncCursor?.calendar ?? null,
    })),
  ];

  if (rows.length === 0) return;

  await db
    .insert(calendarSources)
    .values(rows)
    .onConflictDoNothing({ target: [calendarSources.connectionId, calendarSources.calendarId] });
}

export async function listCalendarSources(userId: string): Promise<CalendarSourceRow[]> {
  const db = await getDb();
  return db.select().from(calendarSources).where(eq(calendarSources.userId, userId));
}

export async function enabledSourcesFor(connectionId: string): Promise<CalendarSourceRow[]> {
  const db = await getDb();
  return db
    .select()
    .from(calendarSources)
    .where(and(eq(calendarSources.connectionId, connectionId), eq(calendarSources.enabled, 1)));
}

export async function saveSourceCursor(
  id: string,
  cursor: CalendarSyncCursor | null,
  syncedAt: Date
): Promise<void> {
  const db = await getDb();
  await db
    .update(calendarSources)
    .set({ syncCursor: cursor, lastSyncedAt: syncedAt, updatedAt: syncedAt })
    .where(eq(calendarSources.id, id));
}

export async function setSourceEnabled(
  userId: string,
  id: string,
  enabled: boolean
): Promise<void> {
  const db = await getDb();
  await db
    .update(calendarSources)
    .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
    .where(and(eq(calendarSources.userId, userId), eq(calendarSources.id, id)));
}
