/**
 * Connecting and managing an iCloud (Apple) calendar account — `src/lib/apple.ts` and
 * `src/actions/apple.ts`.
 *
 * Every DB-touching function under test takes `userId` directly rather than going through
 * `requireUserId()`, so this never needs a Clerk session or demo-mode auth (see
 * `src/lib/apple.ts`'s own header comment) — it calls `connectAppleAccount` /
 * `disconnectAppleAccount` / `readAppleConnectionStatus` themselves, the exact functions
 * `src/actions/apple.ts`'s "use server" wrappers delegate to after `requireUserId()`.
 *
 * What matters most, in order:
 *   1. A wrong password comes back as DATA (`asActionResult`'s `{ ok: false }`), never a
 *      thrown message — a Server Action throw is reduced to an opaque digest in production.
 *   2. Nothing is written until the full CalDAV discovery walk succeeds, and every OTHER way
 *      that walk can fail also comes back as a message, not a blank form.
 *   3. The plaintext app-specific password never round-trips: not in the stored row (it is
 *      AES-GCM ciphertext), and not anywhere in the status payload — not even the ciphertext.
 *   4. Connecting costs nothing — no sync entitlement is required, unlike a pasted
 *      ICS/webcal URL, and `src/actions/apple.ts` cannot reach the gate that would require
 *      one even transitively (an import-graph check, not a source grep — see below).
 *   5. A reconnect clears every calendar's cursor rather than inheriting one from a
 *      possibly-dead connection, and the connection is armed only once its calendars land.
 *   6. Toggling a calendar is scoped to the caller's OWN Apple calendars.
 *
 * Local PGlite. The CalDAV client is stubbed via `ConnectAppleDeps`, so this never reaches
 * the network. Run: npx tsx scripts/smoke-apple-actions.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { getDb } from "../src/db";
import { appleConnections, calendarSources, userSettings } from "../src/db/schema";
import { CalDavAuthError, type CalDavCalendar } from "../src/lib/caldav/client";
import {
  BAD_PASSWORD_MESSAGE,
  UNREACHABLE_MESSAGE,
  connectAppleAccount,
  disconnectAppleAccount,
  readAppleConnectionStatus,
  setAppleCalendarEnabledForUser,
  type ConnectAppleDeps,
} from "../src/lib/apple";
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

// ---------------------------------------------------------------------------------------
// Import-graph check for "connecting is free" — see the check below for why this exists
// instead of a plain source grep, or a behavioral call through requireUserId()/demo mode.
// ---------------------------------------------------------------------------------------

/**
 * Whether `entryFile`'s transitive import graph (following relative and `@/` module
 * specifiers only — bare package imports are not part of this repo's own source graph)
 * ever reaches `bannedFile`.
 *
 * A plain text grep for "requireSyncUser" in `src/actions/apple.ts` would miss the same
 * regression the moment that call moved one file away — this repo has been bitten by
 * exactly that shape of guard before (a source-scanning guard that kept passing after the
 * thing it guarded moved files). Walking the real, parsed import graph instead means the
 * gate is unreachable rather than merely absent from one file's text.
 */
function importsReach(entryFile: string, bannedFile: string): boolean {
  const root = resolve(".");
  const target = resolve(bannedFile);
  const visited = new Set<string>();
  const queue = [resolve(entryFile)];

  function resolveSpecifier(fromFile: string, specifier: string): string | null {
    let base: string;
    if (specifier.startsWith("@/")) base = join(root, "src", specifier.slice(2));
    else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
    else return null; // a bare package import (drizzle-orm, next/cache, …) — out of scope
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  while (queue.length) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    if (file === target) return true;

    const source = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const resolved = resolveSpecifier(file, stmt.moduleSpecifier.text);
      if (resolved) queue.push(resolved);
    }
  }
  return false;
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

/** Both steps stubbed, not just `discoverPrincipal` — a pglite-tier script must not be one
 *  call-order change away from `listCalendars` falling through to the real network. */
const authFailDeps: ConnectAppleDeps = {
  discoverPrincipal: async () => {
    throw new CalDavAuthError();
  },
  listCalendars: async () => {
    throw new Error("smoke: listCalendars must not be reached when discovery already failed");
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
    check(
      "a bad password is returned as data, not thrown, with the exact contract message",
      badResult.ok === false && badResult.error === BAD_PASSWORD_MESSAGE,
      JSON.stringify(badResult)
    );
    check("nothing is stored when discovery fails", (await countConnections(USER)) === 0);

    // --- Every OTHER discovery failure also comes back as a message, not a blank form ----
    console.log("\niCloud unreachable / rejected (not a password problem)");
    const unreachableDeps: ConnectAppleDeps = {
      discoverPrincipal: async () => {
        throw new Error("iCloud: 503 upstream unavailable");
      },
    };
    const unreachableResult = await asActionResult(() =>
      connectAppleAccount(USER, { appleId: "jason@icloud.example", appPassword: APP_PASSWORD }, unreachableDeps)
    );
    check(
      "a non-auth discovery failure is also returned as data, with a reachability message",
      unreachableResult.ok === false && unreachableResult.error.startsWith(UNREACHABLE_MESSAGE),
      JSON.stringify(unreachableResult)
    );
    check("nothing is stored when iCloud is unreachable either", (await countConnections(USER)) === 0);

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
    check("a successful connect arms the connection (nextSyncAt is set)", stored?.nextSyncAt != null);
    check(
      "owned calendars default enabled, the shared one defaults disabled",
      sources.filter((s) => s.enabled === 1).length === 2 &&
        sources.filter((s) => s.readOnly === 1 && s.enabled === 0).length === 1
    );

    const status = await readAppleConnectionStatus(USER);
    const statusJson = JSON.stringify(status);
    check("status never returns the plaintext password", !statusJson.includes(APP_PASSWORD));
    check(
      "status never returns the password, encrypted or otherwise",
      !statusJson.includes(stored!.appPasswordEncrypted)
    );
    check(
      "status reflects the connected calendars",
      status.connected === true && status.calendars.length === 3 && status.emailAddress === "jason@icloud.example"
    );

    // --- A calendar can be toggled off, scoped to the caller's OWN Apple calendars -------
    console.log("\ntoggle");
    const target = sources[0]!;
    await setAppleCalendarEnabledForUser(USER, target.id, false);
    const toggled = await db.query.calendarSources.findFirst({ where: eq(calendarSources.id, target.id) });
    check("a calendar can be toggled off", toggled?.enabled === 0);
    await setAppleCalendarEnabledForUser(USER, target.id, true);

    // A source belonging to another provider (or another user) must be refused, not
    // silently updated at zero rows with a reported success.
    const [foreignSource] = await db
      .insert(calendarSources)
      .values({
        userId: USER,
        provider: "google",
        connectionId: crypto.randomUUID(),
        calendarId: "primary",
        enabled: 1,
      })
      .returning();
    let foreignToggleRefused = false;
    try {
      await setAppleCalendarEnabledForUser(USER, foreignSource!.id, false);
    } catch {
      foreignToggleRefused = true;
    }
    const foreignAfter = await db.query.calendarSources.findFirst({ where: eq(calendarSources.id, foreignSource!.id) });
    check("a non-Apple source id is refused rather than silently toggled", foreignToggleRefused);
    check("the foreign (Google) source is untouched", foreignAfter?.enabled === 1);
    await db.delete(calendarSources).where(eq(calendarSources.id, foreignSource!.id));

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
    check("reconnect re-arms the connection", storedAfterReconnect?.nextSyncAt != null);

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

    // --- A malformed/rejected calendar fails the WHOLE connect, as a message, not a crash --
    console.log("\nmalformed calendar");
    await cleanup();
    const malformedDeps: ConnectAppleDeps = {
      discoverPrincipal: async () => DISCOVERED,
      listCalendars: async () => {
        // Mirrors `listCalendars`'s own host-pin throw on a spoofed/malformed href — a
        // plain Error, not a `CalDavAuthError`, so it takes the same UNREACHABLE_MESSAGE
        // path as any other non-auth discovery failure.
        throw new Error("listCalendars: calendar href failed the host pin");
      },
    };
    const malformedResult = await asActionResult(() =>
      connectAppleAccount(USER, { appleId: "jason@icloud.example", appPassword: APP_PASSWORD }, malformedDeps)
    );
    check(
      "a malformed calendar fails the whole connect as data, not a crash or a partial write",
      malformedResult.ok === false && malformedResult.error.startsWith(UNREACHABLE_MESSAGE)
    );
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

    // `connectAppleAccount` itself (called just above) proves the CODE doesn't gate on an
    // entitlement today. This proves it CAN'T reach the gate even after a refactor: walking
    // `src/actions/apple.ts`'s real, parsed import graph — not a text grep, which would stay
    // green even after the call moved to a file this check never looked at.
    const reachesPlanGuards = importsReach(
      resolve("src/actions/apple.ts"),
      resolve("src/lib/plan-guards.ts")
    );
    check(
      "src/actions/apple.ts's import graph never reaches src/lib/plan-guards.ts (requireSyncUser's home)",
      !reachesPlanGuards
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
