import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailConnections, outlookConnections } from "@/db/schema";
import { deleteCalendarSourcesForProvider } from "@/lib/calendar-sources";
import { dropCloudNoteSource } from "@/lib/cloud-notes/sources";
import { DISCONNECT_DELETE_CATEGORIES } from "@/lib/data-categories";
import { deleteEventConnection } from "@/lib/events/connections";
import { revokeGoogleGrant } from "@/lib/oauth-revoke";
import { purgeUserData } from "@/lib/user-data";

/**
 * Disconnecting Google or Microsoft, as one sequence for every caller.
 *
 * The user's own disconnect (src/actions/gmail.ts, outlook.ts) and the admin's "disconnect
 * integration" had drifted: the admin path deleted the connection row only — no revoke at
 * Google, calendar sources and the confirmation-email scan left behind — while its comment
 * still said it matched. Both now call these.
 *
 * Order: the row first, so the disconnect is done even if Google never answers the revoke.
 */
export async function disconnectGoogleForUser(userId: string, opts: { alsoDelete?: boolean } = {}): Promise<void> {
  const db = await getDb();
  const grant = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { refreshTokenEncrypted: true, accessTokenEncrypted: true },
  });
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, userId));
  // Explicit, not a cascade: calendar_sources has no FK to any connection table (they are
  // deliberately separate — see provider-connections.ts), so a reconnect's fresh connection
  // id would otherwise never dedupe against the orphaned row and seedCalendarSources would
  // double the calendar.
  await deleteCalendarSourcesForProvider(userId, "google");
  await dropCloudNoteSource(userId, "google");
  if (grant) await revokeGoogleGrant(grant);
  if (opts.alsoDelete === true) {
    await purgeUserData(userId, { only: DISCONNECT_DELETE_CATEGORIES.gmail });
  }
  // The confirmation-email scan is an opt-in row that carries no token of its own — it borrows
  // this connection's. Left behind, the scheduler claims it every pass and fails on a mailbox
  // that is no longer connected.
  await deleteEventConnection(userId, "gmail");
}

/** Microsoft has no per-app revoke endpoint; the dialog links the person to their account page. */
export async function disconnectMicrosoftForUser(userId: string, opts: { alsoDelete?: boolean } = {}): Promise<void> {
  const db = await getDb();
  await db.delete(outlookConnections).where(eq(outlookConnections.userId, userId));
  await deleteCalendarSourcesForProvider(userId, "microsoft");
  await dropCloudNoteSource(userId, "microsoft");
  const extra = DISCONNECT_DELETE_CATEGORIES.outlook;
  if (opts.alsoDelete === true && extra.length > 0) {
    await purgeUserData(userId, { only: extra });
  }
}
