/**
 * Connecting and managing an iCloud (Apple) calendar account — `src/lib/apple.ts` and
 * `src/actions/apple.ts`.
 *
 * Every function under test takes `userId` directly rather than going through
 * `requireUserId()`, so this never needs a Clerk session or demo-mode auth (see
 * `src/lib/apple.ts`'s own header comment) — it calls `connectAppleAccount` /
 * `disconnectAppleAccount` / `readAppleConnectionStatus` themselves, the exact functions
 * `src/actions/apple.ts`'s "use server" wrappers delegate to after `requireUserId()`.
 *
 * What matters most, in order:
 *   1. A wrong password comes back as DATA (`asActionResult`'s `{ ok: false }`), never a
 *      thrown message — a Server Action throw is reduced to an opaque digest in production.
 *   2. Nothing is written until the full CalDAV discovery walk succeeds.
 *   3. The plaintext app-specific password never round-trips: not in the stored row (it is
 *      AES-GCM ciphertext), and not anywhere in the status payload.
 *   4. Connecting costs nothing — no sync entitlement is required, unlike a pasted
 *      ICS/webcal URL.
 *   5. A reconnect clears every calendar's cursor rather than inheriting one from a
 *      possibly-dead connection.
 *
 * Local PGlite. The CalDAV client is stubbed via `ConnectAppleDeps`, so this never reaches
 * the network. Run: npx tsx scripts/smoke-apple-actions.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { appleConnections, calendarSources, userSettings } from "../src/db/schema";
import { CalDavAuthError, type CalDavCalendar } from "../src/lib/caldav/client";
import {
  connectAppleAccount,
  disconnectAppleAccount,
  readAppleConnectionStatus,
  type ConnectAppleDeps,
} from "../src/lib/apple";
import { setSourceEnabled } from "../src/lib/calendar-sources";
import { getEntitlements } from "../src/lib/entitlements";
import { asActionResult } from "../src/lib/errors";

const USER = "smoke-apple-actions-user";
const FREE_USER = "smoke-apple-actions-free-user";
const ALL_USERS = [USER, FREE_USER];

// The exact literal `seedApple` in `scripts/smoke-sync-scheduler.ts` uses for the same
// purpose — a stored ciphertext that must never equal this string anywhere it is read back.
const APP_PASSWORD = "app-specific-password";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const DISCOVERED = {
  principalUrl: "https://caldav.icloud.com/123456/principal/",
  calendarHomeUrl: "https://caldav.icloud.com/123456/calendars/",
};

/** Two calendars the user owns (enabled by default) and one shared/subscribed calendar
 *  (disabled by default) — `readOnly` is Apple's own signal for "not mine", per
 *  `CalDavCalendar`'s doc comment. */
const CALENDARS: CalDavCalendar[] = [
  {
    url: "https://caldav.icloud.com/123456/calendars/home/",
    displayName: "Home",
    color: "#FF2D55",
    readOnly: false,
    ctag: "1",
    supportsSync: true,
  },
  {
    url: "https://caldav.icloud.com/123456/calendars/work/",
    displayName: "Work",
    color: "#007AFF",
    readOnly: false,
    ctag: "2",
    supportsSync: true,
  },
  {
    url: "https://caldav.icloud.com/123456/calendars/birthdays-shared-9F2/",
    displayName: "Ada's Birthdays",
    color: null,
    readOnly: true,
    ctag: "3",
    supportsSync: false,
  },
];

const goodDeps: ConnectAppleDeps = {
  discoverPrincipal: async () => DISCOVERED,
  listCalendars: async () => CALENDARS,
};

const authFailDeps: ConnectAppleDeps = {
  discoverPrincipal: async () => {
    throw new CalDavAuthError();
  },
};

async function cleanup() {
  const db = await getDb();
  for (const userId of ALL_USERS) {
    await db.delete(calendarSources).where(eq(calendarSources.userId, userId));
    await db.delete(appleConnections).where(eq(appleConnections.userId, userId));
    await db.delete(userSettings).where(eq(userSettings.userId, userId));
  }
}

async function countConnections(userId: string): Promise<number> {
  const db = await getDb();
  return (await db.select().from(appleConnections).where(eq(appleConnections.userId, userId))).length;
}

run(async () => {
  const db = await getDb();
  await cleanup();

  try {
    // --- A wrong password never writes anything, and comes back as data ------------------
    console.log("\nbad password");
    const badResult = await asActionResult(() =>
      connectAppleAccount(USER, { appleId: "jason@icloud.example", appPassword: "wrong" }, authFailDeps)
    );
    check("a bad password is returned as data, not thrown", badResult.ok === false && badResult.error.length > 0, JSON.stringify(badResult));
    check("nothing is stored when discovery fails", (await countConnections(USER)) === 0);

    // --- A good connection stores the home url and seeds its calendars -------------------
    console.log("\ngood connection");
    const goodResult = await asActionResult(() =>
      connectAppleAccount(USER, { appleId: " Jason@iCloud.example ", appPassword: APP_PASSWORD }, goodDeps)
    );
    check("a good connect succeeds", goodResult.ok === true, goodResult.ok ? "" : goodResult.error);
    check("it reports the calendar count", goodResult.ok === true && goodResult.value.calendars === 3);

    const stored = await db.query.appleConnections.findFirst({ where: eq(appleConnections.userId, USER) });
    const sources = await db
      .select()
      .from(calendarSources)
      .where(eq(calendarSources.connectionId, stored?.id ?? ""));

    check(
      "a good connection stores the home url and seeds its calendars",
      Boolean(stored?.calendarHomeUrl) && sources.length === 3
    );
    check("the Apple ID is normalised (trimmed, lowercased)", stored?.emailAddress === "jason@icloud.example");
    check("the stored password is not the plaintext", stored?.appPasswordEncrypted !== APP_PASSWORD);
    check(
      "owned calendars default enabled, the shared one defaults disabled",
      sources.filter((s) => s.enabled === 1).length === 2 &&
        sources.filter((s) => s.readOnly === 1 && s.enabled === 0).length === 1
    );

    const status = await readAppleConnectionStatus(USER);
    check("status never returns the password", !JSON.stringify(status).includes(APP_PASSWORD));
    check(
      "status reflects the connected calendars",
      status.connected === true && status.calendars.length === 3 && status.emailAddress === "jason@icloud.example"
    );

    // --- A calendar can be toggled off, scoped to its owner -------------------------------
    console.log("\ntoggle");
    const target = sources[0]!;
    await setSourceEnabled(USER, target.id, false);
    const toggled = await db.query.calendarSources.findFirst({ where: eq(calendarSources.id, target.id) });
    check("a calendar can be toggled off", toggled?.enabled === 0);
    await setSourceEnabled(USER, target.id, true);

    // --- Reconnect clears the cursor, rather than carrying one over from a dead connection -
    console.log("\nreconnect clears the cursor");
    const homeSourceId = sources.find((s) => s.calendarId === CALENDARS[0]!.url)!.id;
    await db
      .update(calendarSources)
      .set({ syncCursor: { syncToken: "stale-token-from-a-dead-connection" }, lastSyncedAt: new Date() })
      .where(eq(calendarSources.id, homeSourceId));

    const reconnectResult = await asActionResult(() =>
      connectAppleAccount(USER, { appleId: "jason@icloud.example", appPassword: APP_PASSWORD }, goodDeps)
    );
    check("reconnect succeeds", reconnectResult.ok === true, reconnectResult.ok ? "" : reconnectResult.error);

    const storedAfterReconnect = await db.query.appleConnections.findFirst({
      where: eq(appleConnections.userId, USER),
    });
    check("reconnect keeps the same connection row (upsert, not a duplicate)", storedAfterReconnect?.id === stored?.id);

    const sourcesAfterReconnect = await db
      .select()
      .from(calendarSources)
      .where(eq(calendarSources.connectionId, storedAfterReconnect?.id ?? ""));
    const homeAfterReconnect = sourcesAfterReconnect.find((s) => s.calendarId === CALENDARS[0]!.url);
    check(
      "reconnect clears the cursor rather than carrying it over from the dead connection",
      homeAfterReconnect?.syncCursor == null && homeAfterReconnect?.lastSyncedAt == null
    );
    check("reconnect still seeds exactly the discovered calendars", sourcesAfterReconnect.length === 3);

    // --- A malformed/rejected calendar fails the WHOLE connect, not just that one row -----
    console.log("\nmalformed calendar");
    await cleanup();
    const malformedDeps: ConnectAppleDeps = {
      discoverPrincipal: async () => DISCOVERED,
      listCalendars: async () => {
        // Mirrors `listCalendars`'s own host-pin throw on a spoofed/malformed href — a
        // plain Error, not a `CalDavAuthError`, so `connectAppleAccount` rethrows it as-is.
        throw new Error("listCalendars: calendar href failed the host pin");
      },
    };
    let malformedThrew = false;
    try {
      await connectAppleAccount(USER, { appleId: "jason@icloud.example", appPassword: APP_PASSWORD }, malformedDeps);
    } catch {
      malformedThrew = true;
    }
    check("a malformed calendar fails the whole connect rather than silently dropping it", malformedThrew);
    check("nothing is stored when one calendar is malformed", (await countConnections(USER)) === 0);

    // --- Connecting is free — no sync entitlement is required -----------------------------
    console.log("\nconnecting is free");
    const freePlanEntitlements = await getEntitlements(FREE_USER);
    check(
      "sanity: the test account genuinely lacks the sync entitlement",
      freePlanEntitlements.canUseSync === false,
      JSON.stringify(freePlanEntitlements)
    );
    const connectedOnFreePlan = await asActionResult(() =>
      connectAppleAccount(FREE_USER, { appleId: "free-user@icloud.example", appPassword: APP_PASSWORD }, goodDeps)
    );
    check(
      "connecting is free — no sync entitlement is required",
      connectedOnFreePlan.ok === true,
      connectedOnFreePlan.ok ? "" : connectedOnFreePlan.error
    );

    // --- Disconnect removes the connection and every calendar it seeded -------------------
    console.log("\ndisconnect");
    // Reconnect USER (cleared above by the malformed-calendar check) so disconnect has
    // something real to remove.
    await connectAppleAccount(USER, { appleId: "jason@icloud.example", appPassword: APP_PASSWORD }, goodDeps);
    await disconnectAppleAccount(USER);
    const after = {
      connection: await db.query.appleConnections.findFirst({ where: eq(appleConnections.userId, USER) }),
      sources: await db.select().from(calendarSources).where(eq(calendarSources.userId, USER)),
    };
    check("disconnect removes the connection and its calendars", after.connection === undefined && after.sources.length === 0);

    const statusAfterDisconnect = await readAppleConnectionStatus(USER);
    check(
      "status after disconnect reads as not connected, with no calendars",
      statusAfterDisconnect.connected === false && statusAfterDisconnect.calendars.length === 0
    );
  } finally {
    await cleanup();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Apple connect/disconnect checks passed.");
});
