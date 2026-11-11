import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { events, userSettings } from "@/db/schema";

/** "Let people at the same event find me" — off by default. */
export async function setDiscoverable(userId: string, on: boolean): Promise<void> {
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ discoverableAt: on ? new Date() : null })
    .where(eq(userSettings.userId, userId));
}

export async function isDiscoverable(userId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ at: userSettings.discoverableAt })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  return !!row?.at;
}

/** "Hide me at this event". Owner-scoped: false when the event isn't theirs. */
export async function setHiddenAtEvent(userId: string, eventId: string, hidden: boolean): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) return false;
  const db = await getDb();
  const rows = await db
    .update(events)
    .set({ discoveryHiddenAt: hidden ? new Date() : null })
    .where(and(eq(events.id, eventId), eq(events.userId, userId)))
    .returning();
  return rows.length > 0;
}
