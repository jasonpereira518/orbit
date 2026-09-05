/**
 * The scheduler's operational behaviour, with the provider and the token minter stubbed.
 *
 * What is pinned here is not "does calendar sync work" — that is the connector's and ingest's
 * business, tested separately — but the properties that decide whether continuous sync is
 * safe to leave running unattended: one broken connection cannot stop the others, a dead
 * grant is disarmed rather than retried forever, a transient fault IS retried, a missing
 * scope is recognised as a user problem rather than a fault, and running out of budget hands
 * off instead of dropping work.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { runSyncPass, type SyncDeps } from "../src/lib/sync-scheduler";
import { ReauthRequiredError } from "../src/lib/errors";
import type { CalendarFetchResult } from "../src/lib/connectors/google-calendar";
import { CalendarSyncTokenExpiredError } from "../src/lib/connectors/google-calendar";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function emptyPage(over: Partial<CalendarFetchResult> = {}): CalendarFetchResult {
  return {
    events: [],
    nextSyncToken: "fresh-token",
    nextPageToken: null,
    tombstones: 0,
    selfEmails: [],
    ...over,
  };
}

/**
 * Stub deps whose behaviour is per-user, so one run can mix outcomes across connections.
 *
 * Attribution rides on the access token rather than call order: the scheduler asks for a
 * token per connection and then hands that exact token to the fetcher, so encoding the user
 * id in it is the only way the stub can know which connection it is answering for. Keying on
 * call order instead would silently mis-attribute results the moment the loop's ordering
 * changed — which is exactly what a test of per-connection isolation must not do.
 */
function depsFor(behaviour: Map<string, "ok" | "reauth" | "transient" | "expired">): {
  deps: SyncDeps;
  fetchedFor: string[];
} {
  const fetchedFor: string[] = [];
  const expiredOnce = new Set<string>();
  const deps: SyncDeps = {
    getAccessToken: async (userId: string) => {
      if (behaviour.get(userId) === "reauth") throw new ReauthRequiredError("dead grant");
      return `stub-token:${userId}`;
    },
    fetchPage: async ({ accessToken }) => {
      const userId = String(accessToken).replace(/^stub-token:/, "");
      fetchedFor.push(userId);
      const mode = behaviour.get(userId);
      if (mode === "transient") throw new Error("Google Calendar 503: upstream unavailable");
      if (mode === "expired" && !expiredOnce.has(userId)) {
        expiredOnce.add(userId);
        throw new CalendarSyncTokenExpiredError();
      }
      return emptyPage();
    },
  };
  return { deps, fetchedFor };
}

async function seed(
  userId: string,
  opts: { scopes?: string | null; armed?: boolean } = {}
): Promise<string> {
  const db = await getDb();
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id = ${userId}`);
  const inserted = await db.execute(sql`
    INSERT INTO gmail_connections
      (user_id, email_address, access_token_encrypted, status, scopes, next_sync_at, sync_failures)
    VALUES (
      ${userId}, ${userId + "@example.com"}, 'enc', 'active',
      ${opts.scopes === undefined ? CALENDAR_SCOPE : opts.scopes},
      ${opts.armed === false ? null : new Date(Date.now() - 60_000)}, 0
    )
    RETURNING id
  `);
  return rowsOf<{ id: string }>(inserted)[0].id;
}

type ConnRow = {
  status: string;
  sync_status: string | null;
  next_sync_at: string | Date | null;
  sync_failures: number;
  sync_error: string | null;
};

async function readConn(id: string): Promise<ConnRow> {
  const db = await getDb();
  return rowsOf<ConnRow>(
    await db.execute(sql`
      SELECT status, sync_status, next_sync_at, sync_failures, sync_error
      FROM gmail_connections WHERE id = ${id}
    `)
  )[0];
}

/**
 * Reset to a state where this script is the scheduler's only tenant.
 *
 * `run-smoke.ts` gives every pglite-tier script ONE shared database, and several other
 * scripts create `gmail_connections` rows. Those rows are normally unarmed and therefore
 * invisible — but `smoke-schema-upgrade` rewinds the schema version and reconciles, which
 * re-runs the v27 arming backfill and arms every one of them. `runSyncPass` claims whatever
 * is due, so without this the counts below depend on which scripts ran first.
 *
 * Foreign rows are disarmed rather than deleted: they belong to other scripts, and this one
 * has no business destroying them.
 */
async function clearAll() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id LIKE 'sched-%'`);
  await db.execute(sql`
    UPDATE gmail_connections SET next_sync_at = NULL WHERE user_id NOT LIKE 'sched-%'
  `);
}

run(async () => {
  // --- A healthy connection syncs and is rescheduled ---------------------------------------
  await clearAll();
  {
    const id = await seed("sched-happy");
    const { deps } = depsFor(new Map([["sched-happy", "ok" as const]]));
    const stats = await runSyncPass({ deps });
    check("a due connection is synced", stats.synced === 1, JSON.stringify(stats));
    const row = await readConn(id);
    check("a synced connection returns to idle", row.sync_status === "idle", String(row.sync_status));
    check("a synced connection is rescheduled, not disarmed", row.next_sync_at !== null);
    check("a successful sync leaves consent alone", row.status === "active");
  }

  // --- A connection without the calendar scope is disarmed, not retried ----------------------
  // Its Gmail token is still perfectly valid; only the user reconnecting can grant calendar.
  await clearAll();
  {
    const id = await seed("sched-noscope", { scopes: "https://www.googleapis.com/auth/gmail.readonly" });
    const { deps, fetchedFor } = depsFor(new Map([["sched-noscope", "ok" as const]]));
    const stats = await runSyncPass({ deps });
    check("a connection lacking the calendar scope is skipped", stats.skippedNoScope === 1);
    check("no provider call is made for it", fetchedFor.length === 0, JSON.stringify(fetchedFor));
    const row = await readConn(id);
    check("it is disarmed rather than retried forever", row.next_sync_at === null);
    check("its consent status is untouched", row.status === "active", row.status);
    check(
      "the reason says what the user must do",
      (row.sync_error ?? "").toLowerCase().includes("reconnect"),
      String(row.sync_error)
    );
  }

  // --- A dead grant is not retried; a transient fault is -------------------------------------
  await clearAll();
  {
    const id = await seed("sched-reauth");
    const { deps } = depsFor(new Map([["sched-reauth", "reauth" as const]]));
    const stats = await runSyncPass({ deps });
    check("a dead grant counts as a failure", stats.failed === 1);
    const row = await readConn(id);
    check("a dead grant is disarmed, not rescheduled", row.next_sync_at === null, String(row.next_sync_at));
  }
  await clearAll();
  {
    const id = await seed("sched-transient");
    const { deps } = depsFor(new Map([["sched-transient", "transient" as const]]));
    await runSyncPass({ deps });
    const row = await readConn(id);
    check(
      "a transient provider fault stays armed for a retry",
      row.next_sync_at !== null,
      String(row.next_sync_at)
    );
    check("a transient fault increments the backoff counter", Number(row.sync_failures) === 1);
    check(
      "a transient fault must NOT mark the grant as needing reauth",
      row.status === "active",
      row.status
    );
  }

  // --- An expired syncToken is a lifecycle event, not a fault ---------------------------------
  await clearAll();
  {
    const id = await seed("sched-expired");
    const { deps } = depsFor(new Map([["sched-expired", "expired" as const]]));
    const stats = await runSyncPass({ deps });
    check("a 410 does not fail the run", stats.failed === 0, JSON.stringify(stats));
    const row = await readConn(id);
    check("a 410 leaves the failure counter at zero", Number(row.sync_failures) === 0, String(row.sync_failures));
    check("a 410 leaves the connection armed", row.next_sync_at !== null);
  }

  // --- One broken connection must not stop the others -------------------------------------------
  await clearAll();
  {
    const brokenId = await seed("sched-a-broken");
    const healthyId = await seed("sched-b-healthy");
    const { deps } = depsFor(
      new Map([
        ["sched-a-broken", "transient" as const],
        ["sched-b-healthy", "ok" as const],
      ])
    );
    const stats = await runSyncPass({ deps });
    check(
      "both connections are claimed",
      stats.claimed === 2,
      JSON.stringify(stats)
    );
    check("the healthy one still syncs", stats.synced === 1, JSON.stringify(stats));
    check("the broken one is recorded as failed", stats.failed === 1);
    const broken = await readConn(brokenId);
    const healthy = await readConn(healthyId);
    check("the failure is recorded on the broken connection", broken.sync_error !== null);
    check("the healthy connection is unaffected", healthy.sync_error === null && healthy.sync_status === "idle");
  }

  // --- Exhausting the budget hands off rather than dropping work ---------------------------------
  await clearAll();
  {
    const id = await seed("sched-budget");
    const { deps, fetchedFor } = depsFor(new Map([["sched-budget", "ok" as const]]));
    // A budget already spent: the deadline is checked BEFORE each item, so nothing runs.
    const stats = await runSyncPass({ deps, budgetMs: -1 });
    check("an exhausted budget reports itself", stats.budgetExhausted, JSON.stringify(stats));
    check("no work is attempted past the deadline", fetchedFor.length === 0);
    const row = await readConn(id);
    check(
      "the released connection is left immediately due, not lost",
      row.next_sync_at !== null,
      String(row.next_sync_at)
    );
  }

  // --- An unarmed connection is never picked up ---------------------------------------------------
  await clearAll();
  {
    await seed("sched-unarmed", { armed: false });
    const { deps } = depsFor(new Map([["sched-unarmed", "ok" as const]]));
    const stats = await runSyncPass({ deps });
    check("an unarmed connection is not claimed", stats.claimed === 0, JSON.stringify(stats));
  }

  await clearAll();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll sync-scheduler checks passed.");
});
