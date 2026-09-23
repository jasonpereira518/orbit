/**
 * Reading and seeding `calendar_sources`.
 *
 * `seedCalendarSources` is the migration: it is idempotent (the unique index does the work)
 * and runs on every sync pass, so a connection made before this shipped gains its row the
 * first time it is claimed — and carries its existing cursor across, so nobody pays for a
 * full resync.
 */
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarSources, gmailConnections, outlookConnections } from "@/db/schema";
import type { CalendarSyncCursor } from "@/db/schema";

export type CalendarSourceRow = typeof calendarSources.$inferSelect;
export type CalendarSourceProvider = CalendarSourceRow["provider"];

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
  return db
    .select()
    .from(calendarSources)
    .where(eq(calendarSources.userId, userId))
    .orderBy(asc(calendarSources.createdAt));
}

/**
 * Deletes every `calendar_sources` row this user has for one provider.
 *
 * Called from `disconnectGmail`/`disconnectOutlook` (and, once it exists, Apple's own
 * disconnect) right alongside the connection-row delete. Explicit and provider-scoped because
 * there is no FK to cascade from — the three connection tables are deliberately separate (see
 * `provider-connections.ts`) — and `calendar_sources_conn_cal_uidx` is keyed on
 * `(connection_id, calendar_id)`, not `(user_id, calendar_id)`, so a connection row that is
 * gone leaves its source row behind with nothing to dedupe a reconnect's fresh uuid against.
 * Left uncleaned, a disconnect/reconnect cycle would double the calendar in every source list.
 */
export async function deleteCalendarSourcesForProvider(
  userId: string,
  provider: CalendarSourceProvider
): Promise<void> {
  const db = await getDb();
  await db
    .delete(calendarSources)
    .where(and(eq(calendarSources.userId, userId), eq(calendarSources.provider, provider)));
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
