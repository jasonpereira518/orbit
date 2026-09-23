/**
 * The iCloud (Apple) calendar connection: status reading, the connect/disconnect writes, and
 * the one place a stored app-specific password is ever decrypted.
 *
 * Every function here takes `userId` as a plain parameter rather than calling
 * `requireUserId()` itself, so it can be exercised without a Clerk session —
 * `scripts/smoke-apple-actions.ts` calls these directly. `src/actions/apple.ts` ("use
 * server") is the only production caller, and it supplies `requireUserId()`'s result —
 * never `requireSyncUser()`'s. Connecting any calendar account — Google, Microsoft, Apple —
 * is free (a controller ruling settled this); pasted ICS/webcal URLs are the thing that
 * keeps the sync entitlement gate, not this.
 */
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appleConnections, calendarSources } from "@/db/schema";
import {
  CalDavAuthError,
  discoverPrincipal as discoverPrincipalClient,
  listCalendars as listCalendarsClient,
  type CalDavCalendar,
  type CalDavCredentials,
} from "@/lib/caldav/client";
import { deleteCalendarSourcesForProvider } from "@/lib/calendar-sources";
import { deriveConnectionHealth, type ConnectionHealth } from "@/lib/connection-status";
import { decrypt, encrypt } from "@/lib/crypto";
import { UserFacingError } from "@/lib/errors";

export type AppleConnectionStatus = {
  connected: boolean;
  emailAddress: string | null;
  status: ConnectionHealth | null;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  syncError: string | null;
  calendars: Array<{ id: string; name: string; enabled: boolean; readOnly: boolean }>;
};

/**
 * What Task 10's settings card reads. Deliberately narrow: no `appPasswordEncrypted`, no
 * `principalUrl`/`calendarHomeUrl` (internal sync plumbing, not something a person reads) —
 * only what a status card needs. The password never rides on this even encrypted; see this
 * module's header comment.
 */
export async function readAppleConnectionStatus(userId: string): Promise<AppleConnectionStatus> {
  const db = await getDb();
  const conn = await db.query.appleConnections.findFirst({
    where: eq(appleConnections.userId, userId),
  });

  if (!conn) {
    return {
      connected: false,
      emailAddress: null,
      status: null,
      lastSyncedAt: null,
      nextSyncAt: null,
      syncError: null,
      calendars: [],
    };
  }

  const sources = await db
    .select()
    .from(calendarSources)
    .where(eq(calendarSources.connectionId, conn.id))
    .orderBy(asc(calendarSources.createdAt));

  return {
    connected: conn.status === "active",
    emailAddress: conn.emailAddress,
    // Apple grants no per-feature scopes the way Google/Microsoft do — a CalDAV
    // app-specific password covers calendar or nothing, so this is always true.
    status: deriveConnectionHealth({
      status: conn.status,
      nextSyncAt: conn.nextSyncAt,
      syncError: conn.syncError,
      calendarScopeGranted: true,
    }),
    lastSyncedAt: conn.lastSyncedAt?.toISOString() ?? null,
    nextSyncAt: conn.nextSyncAt?.toISOString() ?? null,
    syncError: conn.syncError ?? null,
    calendars: sources.map((s) => ({
      id: s.id,
      name: s.displayName ?? "Calendar",
      enabled: s.enabled === 1,
      readOnly: s.readOnly === 1,
    })),
  };
}

export type ConnectAppleDeps = {
  /** Injectable for `scripts/smoke-apple-actions.ts`, which must never reach the network. */
  discoverPrincipal?: typeof discoverPrincipalClient;
  listCalendars?: typeof listCalendarsClient;
};

const BAD_PASSWORD_MESSAGE =
  "Apple didn’t accept that — check the app-specific password and try again";

/**
 * Validate an Apple ID + app-specific password against iCloud's own CalDAV discovery walk,
 * and only THEN write anything — so a wrong password fails at the form, not silently at the
 * next sync run. `listCalendars`'s own host pin throws the whole listing if any single href
 * is bad, so a malformed calendar fails this same way: the connect refuses with
 * `BAD_PASSWORD_MESSAGE`'s sibling (a plain rethrow, caught by `asActionResult` in the
 * action) rather than silently dropping the one bad calendar.
 *
 * Reconnecting — calling this again for a user who already has a connection — clears every
 * `calendar_sources` row for the provider before writing the freshly discovered list. That
 * is the cursor obligation `caldav/client.ts`'s own doc comment assigns to this module: a
 * cursor inherited from a dead connection can be stale in ways nothing downstream can detect
 * on its own (a different Apple account reusing a calendar's display name, a calendar
 * deleted and recreated under the same path). The connection row itself is upserted on the
 * same reasoning — every continuous-sync column is reset, not merely the credential.
 */
export async function connectAppleAccount(
  userId: string,
  input: { appleId: string; appPassword: string },
  deps: ConnectAppleDeps = {}
): Promise<{ calendars: number }> {
  const appleId = input.appleId.trim().toLowerCase();
  const password = input.appPassword.trim();
  if (!appleId || !password) {
    throw new UserFacingError("Enter your Apple ID and app-specific password");
  }

  const discover = deps.discoverPrincipal ?? discoverPrincipalClient;
  const list = deps.listCalendars ?? listCalendarsClient;
  const creds: CalDavCredentials = { username: appleId, password };

  let discovered: { principalUrl: string; calendarHomeUrl: string };
  let calendars: CalDavCalendar[];
  try {
    discovered = await discover(creds);
    calendars = await list(creds, discovered.calendarHomeUrl);
  } catch (err) {
    if (err instanceof CalDavAuthError) {
      throw new UserFacingError(BAD_PASSWORD_MESSAGE);
    }
    throw err;
  }

  if (calendars.length === 0) {
    throw new UserFacingError("That Apple ID has no calendars to sync");
  }

  const db = await getDb();
  const now = new Date();
  const appPasswordEncrypted = encrypt(password);

  const [conn] = await db
    .insert(appleConnections)
    .values({
      userId,
      emailAddress: appleId,
      appPasswordEncrypted,
      principalUrl: discovered.principalUrl,
      calendarHomeUrl: discovered.calendarHomeUrl,
      status: "active",
      nextSyncAt: now,
    })
    .onConflictDoUpdate({
      target: appleConnections.userId,
      set: {
        emailAddress: appleId,
        appPasswordEncrypted,
        principalUrl: discovered.principalUrl,
        calendarHomeUrl: discovered.calendarHomeUrl,
        status: "active",
        syncCursor: null,
        nextSyncAt: now,
        syncStatus: null,
        syncStartedAt: null,
        syncError: null,
        syncFailures: 0,
        lastSyncedAt: null,
        updatedAt: now,
      },
    })
    .returning();

  // Every calendar_sources row for this provider — not just the ones whose calendar URL
  // happens to repeat — see this function's own doc comment on the cursor obligation.
  await deleteCalendarSourcesForProvider(userId, "apple");
  await db.insert(calendarSources).values(
    calendars.map((cal) => ({
      userId,
      provider: "apple" as const,
      connectionId: conn.id,
      calendarId: cal.url,
      displayName: cal.displayName,
      color: cal.color,
      // `readOnly` is Apple's own signal for "shared or subscribed, not mine" (see
      // `CalDavCalendar`'s doc comment) — the same flag doubles as the enable-by-default
      // rule: a calendar the user owns starts enabled, one they merely subscribe to or was
      // shared with them starts off.
      readOnly: cal.readOnly ? 1 : 0,
      enabled: cal.readOnly ? 0 : 1,
    }))
  );

  return { calendars: calendars.length };
}

/** Deletes the connection and every `calendar_sources` row it owns. Apple has no OAuth grant
 *  to revoke and no side category to purge (`DISCONNECT_DELETE_CATEGORIES` has no `apple`
 *  entry) — unlike Gmail/Outlook, there is nothing else for this to do. */
export async function disconnectAppleAccount(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(appleConnections).where(eq(appleConnections.userId, userId));
  await deleteCalendarSourcesForProvider(userId, "apple");
}

/**
 * Decrypts one Apple connection's app-specific password into `CalDavCredentials`.
 *
 * The ONE decrypt site — nothing else in the app calls `decrypt` on
 * `apple_connections.app_password_encrypted`. Decrypts fresh on every call rather than
 * caching: Apple mints no token to refresh, so the only per-sync cost this pays that Google
 * and Microsoft do not is one AES-GCM decrypt, far cheaper than the network round trip they
 * both make for a fresh access token.
 */
export async function appleCredentials(connectionId: string): Promise<CalDavCredentials> {
  const db = await getDb();
  const conn = await db.query.appleConnections.findFirst({
    where: eq(appleConnections.id, connectionId),
  });
  if (!conn) {
    throw new Error(`apple_connections row ${connectionId} not found`);
  }
  return { username: conn.emailAddress, password: decrypt(conn.appPasswordEncrypted) };
}
