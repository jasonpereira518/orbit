"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { gmailConnections, userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { hasMailReadScope } from "@/lib/gmail";

export type EmailActivityStatus = {
  /** Whether a Google account is connected at all. */
  connected: boolean;
  /** The connected mailbox, so the user can see whose mail this would read. */
  emailAddress: string | null;
  /** Whether that connection's token can read mail. */
  hasScope: boolean;
  enabled: boolean;
  lastSyncedAt: string | null;
};

export async function getEmailActivityStatus(): Promise<EmailActivityStatus> {
  const userId = await requireUserId();
  const db = await getDb();
  const [conn, settings] = await Promise.all([
    db.query.gmailConnections.findFirst({
      where: eq(gmailConnections.userId, userId),
      columns: { emailAddress: true, scopes: true, lastSyncedAt: true },
    }),
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { emailActivitySync: true },
    }),
  ]);

  return {
    connected: Boolean(conn),
    emailAddress: conn?.emailAddress ?? null,
    hasScope: hasMailReadScope(conn?.scopes),
    enabled: (settings?.emailActivitySync ?? 0) === 1,
    lastSyncedAt: conn?.lastSyncedAt ? new Date(conn.lastSyncedAt).toISOString() : null,
  };
}

/**
 * Turn mailbox activity sync on or off.
 *
 * Off is the default and stays the default for an existing connection: people connect Google
 * to import contacts, sync a calendar or send a follow-up, and none of those is consent to
 * have their mail read. Turning it off stops future passes; it deliberately does NOT delete
 * the interactions already recorded, which are the user's own relationship history and are
 * removable per contact like any other.
 */
export async function setEmailActivitySync(enabled: boolean) {
  const userId = await requireUserId();
  const db = await getDb();
  await db
    .insert(userSettings)
    .values({ userId, emailActivitySync: enabled ? 1 : 0 })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { emailActivitySync: enabled ? 1 : 0, updatedAt: new Date() },
    });
  revalidatePath("/imports");
  return { enabled };
}
