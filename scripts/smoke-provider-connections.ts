/**
 * The sync claim's safety properties, which are all consequences of it being ONE statement.
 *
 * `neon-http` has no transactions, so the scheduler's exclusivity rests entirely on a single
 * `UPDATE ... WHERE id IN (SELECT ... LIMIT n) RETURNING ...` taking its row locks atomically.
 * The things that can quietly break that — a second run claiming the same row, an abandoned
 * lease latching `syncing` forever, a dead grant staying armed and being retried every run —
 * are exactly what this pins.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

// The Meetings switch runs as a server action, so it calls requireUserId(), which resolves to
// "demo-user" only when Clerk is unconfigured (demo mode) — the route smoke-disconnect-cleanup
// already uses. The env is read when the action runs, not when its module loads.
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";
process.env.ORBIT_DEMO_DATA = "off";

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import {
  MAX_SYNC_FAILURES,
  SYNC_LEASE_MS,
  backoffMs,
  claimDueConnections,
  disarmSync,
  loadCoverageSources,
  markSyncResult,
  pauseSync,
  resumeSync,
} from "../src/lib/provider-connections";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { MICROSOFT_SCOPES } from "../src/lib/microsoft-scopes";
import type { ActionResult } from "../src/lib/errors";
import { setCalendarSync as setGoogleCalendarSync } from "../src/actions/gmail";
import { setCalendarSync as setOutlookCalendarSync } from "../src/actions/outlook";
import { ensureUserSettings } from "../src/lib/user-settings";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/**
 * Raw SQL bypasses Drizzle's column mapping, so timestamps arrive as whatever the driver
 * hands back — a `Date` on one, an ISO string on the other. Typed honestly here and
 * normalized through `asDate` rather than annotated as `Date` and hoped for.
 */
type Row = {
  id: string;
  sync_status: string | null;
  next_sync_at: string | Date | null;
  sync_failures: number;
  sync_error: string | null;
};

function asDate(value: string | Date | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

async function seed(userId: string, armedAt: Date | null, scopes: string | null = null): Promise<string> {
  const db = await getDb();
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id = ${userId}`);
  const inserted = await db.execute(sql`
    INSERT INTO gmail_connections (user_id, email_address, access_token_encrypted, status, next_sync_at, scopes)
    VALUES (${userId}, ${userId + "@example.com"}, 'enc', 'active', ${armedAt}, ${scopes})
    RETURNING id
  `);
  return rowsOf<{ id: string }>(inserted)[0].id;
}

async function seedOutlook(userId: string, armedAt: Date | null, scopes: string | null): Promise<string> {
  const db = await getDb();
  await db.execute(sql`DELETE FROM outlook_connections WHERE user_id = ${userId}`);
  const inserted = await db.execute(sql`
    INSERT INTO outlook_connections (user_id, email_address, access_token_encrypted, status, next_sync_at, scopes)
    VALUES (${userId}, ${userId + "@example.com"}, 'enc', 'active', ${armedAt}, ${scopes})
    RETURNING id
  `);
  return rowsOf<{ id: string }>(inserted)[0].id;
}

async function readRow(id: string, table = "gmail_connections"): Promise<Row> {
  const db = await getDb();
  return rowsOf<Row>(
    await db.execute(sql`
      SELECT id, sync_status, next_sync_at, sync_failures, sync_error
      FROM ${sql.raw(table)} WHERE id = ${id}
    `)
  )[0];
}

run(async () => {
  const db = await getDb();
  const past = new Date(Date.now() - 60_000);

  // --- A due connection is claimed exactly once ------------------------------------------
  const dueId = await seed("claim-user", past);
  const first = await claimDueConnections("google", 10);
  check(
    "a due connection is claimed",
    first.some((c) => c.id === dueId),
    `claimed ${first.length}`
  );
  const second = await claimDueConnections("google", 10);
  check(
    "a second run does not re-claim the row it still holds",
    !second.some((c) => c.id === dueId)
  );
  check("the claim marks the row syncing", (await readRow(dueId)).sync_status === "syncing");

  // --- An unarmed connection is never claimed --------------------------------------------
  const unarmedId = await seed("unarmed-user", null);
  const unarmedClaim = await claimDueConnections("google", 10);
  check(
    "next_sync_at IS NULL means never claimed",
    !unarmedClaim.some((c) => c.id === unarmedId)
  );

  // --- An abandoned lease becomes reclaimable, a fresh one does not -----------------------
  await db.execute(sql`
    UPDATE gmail_connections
       SET sync_started_at = ${new Date(Date.now() - SYNC_LEASE_MS - 60_000)}
     WHERE id = ${dueId}
  `);
  const reclaimed = await claimDueConnections("google", 10);
  check(
    "an expired lease is reclaimed rather than latching forever",
    reclaimed.some((c) => c.id === dueId)
  );

  // --- Success clears state and stores the cursor -----------------------------------------
  const nextAt = new Date(Date.now() + 15 * 60_000);
  await markSyncResult("google", dueId, {
    ok: true,
    cursor: { calendar: { syncToken: "tok-1" } },
    nextSyncAt: nextAt,
  });
  const afterOk = await readRow(dueId);
  check("success returns the row to idle", afterOk.sync_status === "idle");
  check("success zeroes the failure counter", Number(afterOk.sync_failures) === 0);
  check("success re-arms the connection", afterOk.next_sync_at !== null);
  const cursorBack = rowsOf<{ tok: string | null }>(
    await db.execute(sql`
      SELECT sync_cursor->'calendar'->>'syncToken' AS tok FROM gmail_connections WHERE id = ${dueId}
    `)
  )[0];
  check("the cursor round-trips", cursorBack.tok === "tok-1", String(cursorBack.tok));

  // --- A retryable failure backs off but stays armed ---------------------------------------
  await markSyncResult("google", dueId, { ok: false, error: "boom", retryable: true });
  const afterFail = await readRow(dueId);
  check("a retryable failure increments the counter", Number(afterFail.sync_failures) === 1);
  check("a retryable failure stays armed", afterFail.next_sync_at !== null);
  check(
    "a retryable failure backs off into the future",
    (asDate(afterFail.next_sync_at) as Date).getTime() > Date.now()
  );

  // --- A non-retryable failure disarms immediately ------------------------------------------
  const deadId = await seed("dead-user", past);
  await claimDueConnections("google", 10);
  await markSyncResult("google", deadId, {
    ok: false,
    error: "scope revoked",
    retryable: false,
  });
  const afterDead = await readRow(deadId);
  check("a non-retryable failure disarms", afterDead.next_sync_at === null);
  check(
    "a disarmed connection is not claimed again",
    !(await claimDueConnections("google", 10)).some((c) => c.id === deadId)
  );

  // --- Repeated retryable failures eventually give up ----------------------------------------
  const wedgedId = await seed("wedged-user", past);
  await db.execute(sql`
    UPDATE gmail_connections SET sync_failures = ${MAX_SYNC_FAILURES - 1} WHERE id = ${wedgedId}
  `);
  await markSyncResult("google", wedgedId, { ok: false, error: "still broken", retryable: true });
  const afterGiveUp = await readRow(wedgedId);
  check(
    `giving up at ${MAX_SYNC_FAILURES} failures disarms rather than retrying forever`,
    afterGiveUp.next_sync_at === null,
    `failures=${afterGiveUp.sync_failures}`
  );

  // --- disarmSync leaves consent alone -------------------------------------------------------
  const consentId = await seed("consent-user", past);
  await disarmSync("google", consentId, "transport error");
  const consentRow = rowsOf<{ status: string }>(
    await db.execute(sql`SELECT status FROM gmail_connections WHERE id = ${consentId}`)
  )[0];
  check(
    "disarming a connection never touches its consent status",
    consentRow.status === "active",
    consentRow.status
  );

  // --- Backoff is bounded and jittered --------------------------------------------------------
  const day = 24 * 60 * 60 * 1000;
  check("backoff never exceeds a day", backoffMs(99) <= day * 1.2 && backoffMs(99) >= day * 0.8);
  check("backoff grows with failures", backoffMs(1) < backoffMs(4));
  const samples = new Set(Array.from({ length: 8 }, () => backoffMs(3)));
  check("backoff is jittered, not a fixed ladder", samples.size > 1);

  // --- Coverage requires an actual sync, not merely a row --------------------------------------
  const covId = await seed("coverage-user", null);
  const noSync = await loadCoverageSources("coverage-user");
  check("a connected mailbox counts as mail coverage", noSync.mailConnected);
  check(
    "a calendar scope that has never synced does not count as coverage",
    !noSync.calendarConnected
  );
  await db.execute(sql`
    UPDATE gmail_connections
       SET scopes = 'https://www.googleapis.com/auth/calendar.readonly', last_synced_at = now()
     WHERE id = ${covId}
  `);
  const synced = await loadCoverageSources("coverage-user");
  check("a synced calendar scope does count as coverage", synced.calendarConnected);

  // Microsoft echoes Graph scopes as a short name, a full URI, in any case; and the test is an
  // exact token, so a look-alike is not coverage.
  const outlookCoverage = async (userId: string, scopes: string, synced = true) => {
    await db.execute(sql`DELETE FROM outlook_connections WHERE user_id = ${userId}`);
    await db.execute(sql`
      INSERT INTO outlook_connections (user_id, email_address, access_token_encrypted, status, scopes, last_synced_at)
      VALUES (${userId}, ${userId + "@example.com"}, 'enc', 'active', ${scopes}, ${synced ? new Date() : null})
    `);
    return (await loadCoverageSources(userId)).calendarConnected;
  };
  check("a short-name Microsoft calendar grant is coverage", await outlookCoverage("cov-ms-short", "openid Calendars.Read"));
  check("a full-URI Microsoft calendar grant is coverage", await outlookCoverage("cov-ms-uri", "https://graph.microsoft.com/Calendars.Read"));
  check("a lower-case Microsoft calendar grant is coverage", await outlookCoverage("cov-ms-lower", "openid https://graph.microsoft.com/calendars.read"));
  check("a Microsoft calendar grant that never synced is not coverage", !(await outlookCoverage("cov-ms-unsynced", "Calendars.Read", false)));
  check("a Microsoft look-alike scope is not coverage", !(await outlookCoverage("cov-ms-lookalike", "Calendars.ReadWrite https://graph.microsoft.com/Calendars.Read.Shared")));
  check("a Microsoft contacts-only grant is not calendar coverage", !(await outlookCoverage("cov-ms-contacts", "https://graph.microsoft.com/Contacts.Read")));
  await db.execute(sql`DELETE FROM outlook_connections WHERE user_id LIKE 'cov-ms-%'`);

  const stranger = await loadCoverageSources("nobody-at-all");
  check("an unconnected user has no coverage", !stranger.mailConnected && !stranger.calendarConnected);

  // --- pauseSync/resumeSync take a connection out of the queue and put it back again ---------
  console.log("\npausing and resuming on purpose");
  const pauseUserId = "pause-resume-user";
  const pauseId = await seed(pauseUserId, past);
  await pauseSync("google", pauseUserId);
  const pausedRow = await readRow(pauseId);
  check("a paused connection is not queued", pausedRow.next_sync_at === null);
  check(
    "and is marked paused, not failed",
    pausedRow.sync_status === "paused" && pausedRow.sync_error === null
  );
  check(
    "the scheduler does not claim it",
    !(await claimDueConnections("google", 10)).some((c) => c.id === pauseId)
  );
  await resumeSync("google", pauseUserId);
  const resumedRow = await readRow(pauseId);
  check(
    "resuming queues it again",
    resumedRow.next_sync_at !== null && resumedRow.sync_status === null
  );
  check(
    "the scheduler claims it once more",
    (await claimDueConnections("google", 10)).some((c) => c.id === pauseId)
  );

  // --- turning meetings back on needs a grant that actually covers calendar --------------------
  //
  // `resumeSync` arms the row whatever the grant covers, and the upsert deliberately never arms
  // one that lacks calendar: the scheduler would claim it, disarm it for the missing scope, and
  // report "paused" to someone who never asked for calendar. So the guard has to live in the
  // action — which a direct POST can reach without ever passing the switch.
  console.log("\nturning meetings on needs a grant that covers calendar");
  const DEMO = "demo-user";
  await ensureUserSettings(DEMO);

  /**
   * The refusal message, or null when the switch went through. The action answers with an
   * `ActionResult` rather than throwing — a thrown Server Action message reaches the browser
   * as a digest, and the Meetings switch shows this refusal verbatim — so a refusal arrives
   * as `ok: false`. A call that went through still ends in `revalidatePath`'s invariant,
   * since there is no router cache to invalidate outside a real Next.js request, after every
   * write it makes has landed. The same swallow smoke-disconnect-cleanup uses.
   */
  async function switchOn(turnOn: () => Promise<ActionResult<void>>): Promise<string | null> {
    try {
      const result = await turnOn();
      return result.ok ? null : result.error;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return message.startsWith("Invariant: static generation store missing") ? null : message;
    }
  }

  const gContactsOnlyId = await seed(DEMO, null, `openid ${GOOGLE_SCOPES.contacts}`);
  const gRefusal = await switchOn(() => setGoogleCalendarSync(true));
  check("a contacts-only Google grant is refused", gRefusal !== null, String(gRefusal));
  check(
    "and is left out of the queue",
    (await readRow(gContactsOnlyId)).next_sync_at === null
  );
  check(
    "the refusal says what to do about it",
    (gRefusal ?? "").includes("calendar access"),
    String(gRefusal)
  );

  const gCalendarId = await seed(DEMO, null, `openid ${GOOGLE_SCOPES.calendar}`);
  check("a calendar-covering Google grant is accepted", (await switchOn(() => setGoogleCalendarSync(true))) === null);
  check("and is armed", (await readRow(gCalendarId)).next_sync_at !== null);

  const mContactsOnlyId = await seedOutlook(DEMO, null, `openid ${MICROSOFT_SCOPES.contacts}`);
  const mRefusal = await switchOn(() => setOutlookCalendarSync(true));
  check("a contacts-only Microsoft grant is refused", mRefusal !== null, String(mRefusal));
  check(
    "and is left out of the queue",
    (await readRow(mContactsOnlyId, "outlook_connections")).next_sync_at === null
  );

  // Graph echoes a real grant as a short name in any case, so the guard must read it through
  // `hasCalendarScope` — a raw string test here would refuse a connection that has calendar.
  const mCalendarId = await seedOutlook(DEMO, null, "openid calendars.read");
  check("a calendar-covering Microsoft grant is accepted, in Graph's short spelling", (await switchOn(() => setOutlookCalendarSync(true))) === null);
  check("and is armed", (await readRow(mCalendarId, "outlook_connections")).next_sync_at !== null);

  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id = ${DEMO}`);
  await db.execute(sql`DELETE FROM outlook_connections WHERE user_id = ${DEMO}`);

  // --- a sync claimed before the pause cannot resurrect or mislabel it once it finishes -------
  console.log("\na sync in flight cannot undo a pause");
  const raceSuccessId = await seed("pause-race-success", past);
  await claimDueConnections("google", 10);
  await pauseSync("google", "pause-race-success");
  await markSyncResult("google", raceSuccessId, {
    ok: true,
    cursor: null,
    nextSyncAt: new Date(Date.now() + 15 * 60_000),
  });
  const afterLateSuccess = await readRow(raceSuccessId);
  check(
    "a success that lands after the pause does not re-arm it",
    afterLateSuccess.next_sync_at === null && afterLateSuccess.sync_status === "paused"
  );

  const raceDisarmId = await seed("pause-race-disarm", past);
  await claimDueConnections("google", 10);
  await pauseSync("google", "pause-race-disarm");
  await markSyncResult("google", raceDisarmId, { ok: false, error: "scope revoked", retryable: false });
  const afterLateDisarm = await readRow(raceDisarmId);
  check(
    "a disarm that lands after the pause does not relabel it broken",
    afterLateDisarm.sync_status === "paused" && afterLateDisarm.sync_error === null
  );

  // Same race on the retryable-but-not-yet-disarmed path — not explicitly called out, but the
  // same unguarded `WHERE id = …` pattern, so it gets the same guard and the same coverage.
  const raceRetryId = await seed("pause-race-retry", past);
  await claimDueConnections("google", 10);
  await pauseSync("google", "pause-race-retry");
  await markSyncResult("google", raceRetryId, { ok: false, error: "transient", retryable: true });
  const afterLateRetry = await readRow(raceRetryId);
  check(
    "a retryable failure that lands after the pause does not arm a retry either",
    afterLateRetry.sync_status === "paused" &&
      afterLateRetry.next_sync_at === null &&
      afterLateRetry.sync_error === null
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll provider-connection checks passed.");
});
