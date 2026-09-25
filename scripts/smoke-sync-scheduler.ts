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
import { encrypt } from "../src/lib/crypto";
import type { CalendarFetchResult } from "../src/lib/connectors/google-calendar";
import { CalendarSyncTokenExpiredError } from "../src/lib/connectors/google-calendar";
import { MAX_SYNC_FAILURES } from "../src/lib/provider-connections";
import { CalDavRejectedError } from "../src/lib/caldav/client";

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

/** Seeds one iCloud connection with a real (fake) encrypted app-specific password. */
async function seedApple(userId: string, opts: { armed?: boolean } = {}): Promise<string> {
  const db = await getDb();
  await db.execute(sql`DELETE FROM apple_connections WHERE user_id = ${userId}`);
  const inserted = await db.execute(sql`
    INSERT INTO apple_connections
      (user_id, email_address, app_password_encrypted, status, next_sync_at, sync_failures)
    VALUES (
      ${userId}, ${userId + "@icloud.example"}, ${encrypt("app-specific-password")}, 'active',
      ${opts.armed === false ? null : new Date(Date.now() - 60_000)}, 0
    )
    RETURNING id
  `);
  return rowsOf<{ id: string }>(inserted)[0].id;
}

async function readAppleConn(id: string): Promise<ConnRow> {
  const db = await getDb();
  return rowsOf<ConnRow>(
    await db.execute(sql`
      SELECT status, sync_status, next_sync_at, sync_failures, sync_error
      FROM apple_connections WHERE id = ${id}
    `)
  )[0];
}

type SourceRow = {
  id: string;
  calendar_id: string;
  enabled: number;
  sync_cursor: { syncToken?: string | null } | string | null;
  last_synced_at: string | Date | null;
};

function sourceCursorOf(row: SourceRow | undefined): { syncToken?: string | null } | null {
  if (!row) return null;
  const raw = row.sync_cursor;
  if (raw == null) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function seedCalendarSource(
  connectionId: string,
  calendarId: string,
  opts: { enabled?: boolean; lastSyncedAt?: Date | null } = {}
): Promise<string> {
  const db = await getDb();
  const inserted = await db.execute(sql`
    INSERT INTO calendar_sources (user_id, provider, connection_id, calendar_id, enabled, last_synced_at)
    VALUES (
      (SELECT user_id FROM apple_connections WHERE id = ${connectionId}),
      'apple', ${connectionId}, ${calendarId},
      ${opts.enabled === false ? 0 : 1},
      ${opts.lastSyncedAt ?? null}
    )
    RETURNING id
  `);
  return rowsOf<{ id: string }>(inserted)[0].id;
}

async function readSource(id: string): Promise<SourceRow> {
  const db = await getDb();
  return rowsOf<SourceRow>(
    await db.execute(sql`
      SELECT id, calendar_id, enabled, sync_cursor, last_synced_at FROM calendar_sources WHERE id = ${id}
    `)
  )[0];
}

/** Unlike `readSource`, keyed by the connection rather than the source row's own id — for a
 * migration check that does not yet know the row's id, because `seedCalendarSources` creates
 * it during the very sync pass under test. */
async function readSourceByConnection(connectionId: string): Promise<SourceRow | undefined> {
  const db = await getDb();
  return rowsOf<SourceRow>(
    await db.execute(sql`
      SELECT id, calendar_id, enabled, sync_cursor, last_synced_at
      FROM calendar_sources WHERE connection_id = ${connectionId}
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
  await db.execute(sql`DELETE FROM outlook_connections WHERE user_id LIKE 'sched-%'`);
  await db.execute(sql`
    UPDATE outlook_connections SET next_sync_at = NULL WHERE user_id NOT LIKE 'sched-%'
  `);
  await db.execute(sql`DELETE FROM apple_connections WHERE user_id LIKE 'sched-%'`);
  await db.execute(sql`
    UPDATE apple_connections SET next_sync_at = NULL WHERE user_id NOT LIKE 'sched-%'
  `);
  await db.execute(sql`DELETE FROM calendar_sources WHERE user_id LIKE 'sched-%'`);
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

  // --- A platform invite becomes an EVENT, and never a fabricated meeting ------------------------
  //
  // The bug this pins cost the user real data: `counterpartsOf` treats the organiser as a
  // counterpart, so a 200-person Luma party looked like a 1:1 with `invites@lu.ma` — creating
  // a contact named "invites", logging a meeting nobody attended, and scheduling a follow-up
  // nudge to a mailbox. Both halves have to hold at once, which is why this lives here rather
  // than in either feature's own script.
  await clearAll();
  {
    const db = await getDb();
    const USER = "sched-discovery";
    await db.execute(sql`DELETE FROM event_aliases WHERE user_id = ${USER}`);
    await db.execute(sql`DELETE FROM event_attendees WHERE user_id = ${USER}`);
    await db.execute(sql`DELETE FROM events WHERE user_id = ${USER}`);
    await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
    await db.execute(sql`DELETE FROM interactions WHERE user_id = ${USER}`);

    await seed(USER);
    const { deps } = depsFor(new Map([[USER, "ok" as const]]));
    // The event page the enrichment pass will read, served from here rather than the
    // internet: a suite that actually fetches lu.ma is slow, flaky and impolite.
    const page = `<html><head>
      <title>AI Tinkerers SF — the real title</title>
      <script type="application/ld+json">${JSON.stringify({
        "@type": "Event",
        name: "AI Tinkerers SF",
        startDate: "2026-06-01T11:00:00-07:00",
        location: { "@type": "Place", name: "Shack15", address: { addressLocality: "San Francisco" } },
      })}</script>
    </head><body></body></html>`;

    const withInvite: SyncDeps = {
      ...deps,
      eventPageFetch: (async () =>
        new Response(page, {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
      fetchPage: async () =>
        emptyPage({
          selfEmails: [`${USER}@example.com`],
          events: [
            {
              uid: "gcal-luma-party",
              summary: "AI Tinkerers SF",
              description: "RSVP: https://lu.ma/ai-tinkerers-sched",
              location: "Shack15",
              start: new Date("2026-06-01T18:00:00.000Z"),
              end: new Date("2026-06-01T21:00:00.000Z"),
              organizer: { name: "Luma", email: "invites@lu.ma" },
              attendees: [
                { name: "You", email: `${USER}@example.com` },
                { name: "Ada Lovelace", email: "ada@analytical.io" },
              ],
            },
          ],
        }),
    };

    const stats = await runSyncPass({ deps: withInvite });
    check("the invite becomes an event", stats.discoveryCreated === 1, JSON.stringify(stats));
    check("and no meeting is logged from it", stats.interactionsLogged === 0, String(stats.interactionsLogged));
    check("and no contact is created", stats.contactsCreated === 0, String(stats.contactsCreated));

    const counts = rowsOf<{ events: number; contacts: number; attendees: number }>(
      await db.execute(sql`
        SELECT (SELECT count(*)::int FROM events WHERE user_id = ${USER})          AS events,
               (SELECT count(*)::int FROM contacts WHERE user_id = ${USER})        AS contacts,
               (SELECT count(*)::int FROM event_attendees WHERE user_id = ${USER}) AS attendees
      `)
    )[0]!;
    check("exactly one event row", counts.events === 1, String(counts.events));
    check("the other guest is on its roster", counts.attendees === 1, String(counts.attendees));
    check("the contacts table is untouched", counts.contacts === 0, String(counts.contacts));

    // Re-running the same page must not produce a second event.
    await db.execute(sql`UPDATE gmail_connections SET next_sync_at = now() - interval '1 minute' WHERE user_id = ${USER}`);
    const again = await runSyncPass({ deps: withInvite });
    check("a second pass attaches rather than duplicating", again.discoveryCreated === 0, JSON.stringify(again));
    const after = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM events WHERE user_id = ${USER}`)
    )[0]!.n;
    check("still one event", after === 1, String(after));

    // The point of the whole queue: a calendar line says "AI Tinkerers SF", and the page
    // behind its link says where, when and what it actually is — with nobody there to press
    // Refresh.
    check("the page was read in the background", again.enrichFetched === 1, JSON.stringify(again));
    const enriched = rowsOf<{ city: string | null; enrich_due_at: Date | null }>(
      await db.execute(sql`SELECT city, enrich_due_at FROM events WHERE user_id = ${USER}`)
    )[0]!;
    check("and its details landed", enriched.city === "San Francisco", String(enriched.city));
    check("and it left the queue", enriched.enrich_due_at === null);
  }

  // --- Microsoft: a real grant is not read as "no calendar scope" ---------------------------------
  //
  // Microsoft echoes Graph scopes as short names or full URIs, in any case. A case-sensitive
  // full-URI substring test read a genuine "Calendars.Read" as no calendar and disarmed the
  // connection — silently, for a user who had done everything right.
  await clearAll();
  {
    const db = await getDb();
    await db.execute(sql`DELETE FROM outlook_connections WHERE user_id LIKE 'sched-ms-%'`);
    await db.execute(sql`UPDATE outlook_connections SET next_sync_at = NULL WHERE user_id NOT LIKE 'sched-ms-%'`);
    const seedMs = async (userId: string, scopes: string): Promise<string> => {
      const inserted = await db.execute(sql`
        INSERT INTO outlook_connections
          (user_id, email_address, access_token_encrypted, status, scopes, next_sync_at, sync_failures)
        VALUES (${userId}, ${userId + "@example.com"}, 'enc', 'active', ${scopes}, ${new Date(Date.now() - 60_000)}, 0)
        RETURNING id
      `);
      return rowsOf<{ id: string }>(inserted)[0].id;
    };
    const readMs = async (id: string) =>
      rowsOf<{ next_sync_at: string | Date | null; sync_error: string | null }>(
        await db.execute(sql`SELECT next_sync_at, sync_error FROM outlook_connections WHERE id = ${id}`)
      )[0];

    const shortId = await seedMs("sched-ms-short", "openid Calendars.Read");
    const uriId = await seedMs("sched-ms-uri", "https://graph.microsoft.com/calendars.read openid");
    const contactsId = await seedMs("sched-ms-contacts", "https://graph.microsoft.com/Contacts.Read");
    const lookalikeId = await seedMs("sched-ms-lookalike", "Calendars.ReadWrite");

    const fetchedFor: string[] = [];
    const { deps } = depsFor(new Map());
    deps.getMicrosoftAccessToken = async (userId: string) => `stub-token:${userId}`;
    deps.fetchMicrosoftPage = async ({ accessToken }) => {
      fetchedFor.push(String(accessToken).replace(/^stub-token:/, ""));
      return emptyPage();
    };
    const stats = await runSyncPass({ deps });
    check("both calendar grants are synced, whatever their form", stats.synced === 2, JSON.stringify(stats));
    check("a short-form Calendars.Read is fetched", fetchedFor.includes("sched-ms-short"), JSON.stringify(fetchedFor));
    check("a mixed-case full-URI grant is fetched", fetchedFor.includes("sched-ms-uri"), JSON.stringify(fetchedFor));
    check("a short-form grant is rescheduled, not disarmed", (await readMs(shortId)).next_sync_at !== null);
    check("its sync_error stays empty", (await readMs(shortId)).sync_error === null, String((await readMs(shortId)).sync_error));
    check("a mixed-case full-URI grant is rescheduled, not disarmed", (await readMs(uriId)).next_sync_at !== null);
    check("a contacts-only connection is skipped", stats.skippedNoScope === 2, JSON.stringify(stats));
    check("…and disarmed with a reason the user can act on", (await readMs(contactsId)).next_sync_at === null && /reconnect/i.test((await readMs(contactsId)).sync_error ?? ""));
    check("a look-alike scope is not calendar access", (await readMs(lookalikeId)).next_sync_at === null && !fetchedFor.includes("sched-ms-lookalike"));
    await db.execute(sql`DELETE FROM outlook_connections WHERE user_id LIKE 'sched-ms-%'`);
  }

  // --- An unarmed connection is never picked up ---------------------------------------------------
  await clearAll();
  {
    await seed("sched-unarmed", { armed: false });
    const { deps } = depsFor(new Map([["sched-unarmed", "ok" as const]]));
    const stats = await runSyncPass({ deps });
    check("an unarmed connection is not claimed", stats.claimed === 0, JSON.stringify(stats));
  }

  // --- Google: a pre-existing connection-level cursor threads through the migration ---------
  //
  // `smoke-calendar-source-rows.ts` proves the seeder itself moves a cursor onto a fresh row, but
  // never runs it through the scheduler; the checks above never read `calendar_sources` back
  // for Google or Microsoft at all. So a `syncGoogleCalendar` that read the wrong field, or
  // never called `saveSourceCursor`, would pass every other check in this file. This one seeds
  // a connection carrying a pre-migration cursor exactly like a real pre-existing user, runs a
  // real `runSyncPass`, and asserts both ends: the OLD cursor is what reaches `fetchPage` (the
  // migration did not silently restart from scratch), and the NEW cursor lands on
  // `calendar_sources` (the write moved, not just the read).
  await clearAll();
  {
    const db = await getDb();
    const userId = "sched-migrate-google";
    await db.execute(sql`DELETE FROM gmail_connections WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM calendar_sources WHERE user_id = ${userId}`);
    const inserted = await db.execute(sql`
      INSERT INTO gmail_connections
        (user_id, email_address, access_token_encrypted, status, scopes, sync_cursor, next_sync_at, sync_failures)
      VALUES (
        ${userId}, ${userId + "@example.com"}, 'enc', 'active', ${CALENDAR_SCOPE},
        ${JSON.stringify({ calendar: { syncToken: "pre-migration-tok", pageToken: null } })}::jsonb,
        ${new Date(Date.now() - 60_000)}, 0
      )
      RETURNING id
    `);
    const connId = rowsOf<{ id: string }>(inserted)[0].id;

    let cursorSeen: unknown = "not called";
    const deps: SyncDeps = {
      getAccessToken: async () => `stub-token:${userId}`,
      fetchPage: async ({ cursor }) => {
        cursorSeen = cursor;
        return emptyPage({ nextSyncToken: "post-migration-tok" });
      },
    };
    await runSyncPass({ deps });
    check(
      "the pre-existing connection-level cursor is what reaches fetchPage on the migrating pass",
      (cursorSeen as { syncToken?: string | null } | null)?.syncToken === "pre-migration-tok",
      JSON.stringify(cursorSeen)
    );
    const source = await readSourceByConnection(connId);
    check(
      "the resulting cursor lands on calendar_sources, not just the connection",
      sourceCursorOf(source)?.syncToken === "post-migration-tok",
      JSON.stringify(source?.sync_cursor)
    );
    await db.execute(sql`DELETE FROM gmail_connections WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM calendar_sources WHERE user_id = ${userId}`);
  }

  // --- Apple: several calendars on one connection, each with its own cursor -----------------
  await clearAll();
  {
    const connId = await seedApple("sched-apple-happy");
    const sourceAId = await seedCalendarSource(connId, "cal-a", { lastSyncedAt: new Date(Date.now() - 2 * 60_000) });
    const sourceBId = await seedCalendarSource(connId, "cal-b", { lastSyncedAt: new Date(Date.now() - 60_000) });
    const disabledCalendarUrl = "cal-disabled";
    await seedCalendarSource(connId, disabledCalendarUrl, { enabled: false });

    const fetched: string[] = [];
    const deps: SyncDeps = {
      getAccessToken: async () => "unused",
      fetchPage: async () => emptyPage(),
      fetchApplePage: async ({ calendarUrl }) => {
        fetched.push(calendarUrl);
        return emptyPage({ nextSyncToken: `${calendarUrl === "cal-a" ? "a" : "b"}2` });
      },
    };
    const stats = await runSyncPass({ deps });
    check("an armed apple connection is claimed and synced", stats.synced === 1, JSON.stringify(stats));
    check("a disabled calendar is never fetched", !fetched.includes(disabledCalendarUrl), JSON.stringify(fetched));

    const sourceA = await readSource(sourceAId);
    const sourceB = await readSource(sourceBId);
    check(
      "each enabled calendar advances its own cursor",
      sourceCursorOf(sourceA)?.syncToken === "a2" && sourceCursorOf(sourceB)?.syncToken === "b2",
      `a=${JSON.stringify(sourceA?.sync_cursor)} b=${JSON.stringify(sourceB?.sync_cursor)}`
    );
  }

  // --- Apple: a revoked app-specific password disarms rather than retrying forever ----------
  await clearAll();
  {
    const connId = await seedApple("sched-apple-revoked");
    await seedCalendarSource(connId, "cal-a");
    const deps: SyncDeps = {
      getAccessToken: async () => "unused",
      fetchPage: async () => emptyPage(),
      fetchApplePage: async () => {
        throw new ReauthRequiredError("app-specific password revoked");
      },
    };
    await runSyncPass({ deps });
    const afterRevoke = await readAppleConn(connId);
    check(
      "a revoked app password disarms rather than retrying",
      afterRevoke.next_sync_at === null && Number(afterRevoke.sync_failures) < MAX_SYNC_FAILURES,
      JSON.stringify(afterRevoke)
    );
  }

  // --- Apple: a stale-token resync is bounded to one retry per calendar per pass ------------
  //
  // Unlike Google/Microsoft, `apple-calendar.ts` can raise `CalendarSyncTokenExpiredError` from
  // its cursor-LESS fallback path — so an unguarded `cursor = null; continue;` would re-issue
  // the identical request forever, hanging the whole pass. This pins that it does not: a
  // provider that NEVER stops answering "stale" gets called at most twice (the real attempt,
  // then one resync retry) before the calendar's failure is counted and the pass moves on.
  await clearAll();
  {
    const connId = await seedApple("sched-apple-stale-loop");
    await seedCalendarSource(connId, "cal-a");
    let calls = 0;
    const deps: SyncDeps = {
      getAccessToken: async () => "unused",
      fetchPage: async () => emptyPage(),
      fetchApplePage: async () => {
        calls++;
        throw new CalendarSyncTokenExpiredError();
      },
    };
    const stats = await runSyncPass({ deps });
    check("a resync that never stabilizes is bounded, not retried forever", calls <= 2, `calls=${calls}`);
    check("it still counts as a failure", stats.failed === 1, JSON.stringify(stats));
    const conn = await readAppleConn(connId);
    check(
      "a bounded resync failure backs off rather than disarming outright",
      conn.next_sync_at !== null && Number(conn.sync_failures) === 1,
      JSON.stringify(conn)
    );
  }

  // --- Apple: one rejected calendar does not starve or take down its siblings --------------
  //
  // `CalDavRejectedError` (a deleted calendar, a revoked share) on the OLDEST-sorted calendar
  // must not abort the fan-out before the others get a turn, and must not be swallowed either
  // — the connection still needs its counted failure so a permanently broken calendar
  // eventually disarms.
  await clearAll();
  {
    const connId = await seedApple("sched-apple-partial-fail");
    const oldest = new Date(Date.now() - 3 * 60_000);
    const middle = new Date(Date.now() - 2 * 60_000);
    const newest = new Date(Date.now() - 60_000);
    const sourceFailId = await seedCalendarSource(connId, "cal-fail", { lastSyncedAt: oldest });
    const sourceBId = await seedCalendarSource(connId, "cal-b", { lastSyncedAt: middle });
    const sourceCId = await seedCalendarSource(connId, "cal-c", { lastSyncedAt: newest });
    const fetched: string[] = [];
    const deps: SyncDeps = {
      getAccessToken: async () => "unused",
      fetchPage: async () => emptyPage(),
      fetchApplePage: async ({ calendarUrl }) => {
        fetched.push(calendarUrl);
        if (calendarUrl === "cal-fail") throw new CalDavRejectedError(403, "calendar revoked");
        return emptyPage({ nextSyncToken: `${calendarUrl}-tok` });
      },
    };
    const before = Date.now();
    const stats = await runSyncPass({ deps });
    check("the rejected calendar is counted as a connection-level failure", stats.failed === 1, JSON.stringify(stats));
    check("it is not ALSO counted as synced", stats.synced === 0, JSON.stringify(stats));
    check(
      "the other two calendars are still fetched, not starved behind the failing one",
      fetched.includes("cal-b") && fetched.includes("cal-c"),
      JSON.stringify(fetched)
    );
    const sourceFail = await readSource(sourceFailId);
    const sourceB = await readSource(sourceBId);
    const sourceC = await readSource(sourceCId);
    check("the healthy calendars' cursors advanced", sourceCursorOf(sourceB)?.syncToken === "cal-b-tok" && sourceCursorOf(sourceC)?.syncToken === "cal-c-tok", `b=${JSON.stringify(sourceB?.sync_cursor)} c=${JSON.stringify(sourceC?.sync_cursor)}`);
    check("the failing calendar's cursor is untouched", sourceCursorOf(sourceFail) === null, JSON.stringify(sourceFail?.sync_cursor));
    check(
      "the failing calendar's lastSyncedAt still advances, so it rotates out of first place next pass",
      sourceFail.last_synced_at !== null && new Date(sourceFail.last_synced_at).getTime() >= before,
      String(sourceFail.last_synced_at)
    );
    const conn = await readAppleConn(connId);
    check(
      "the connection backs off rather than disarming on a single rejection",
      conn.next_sync_at !== null && Number(conn.sync_failures) === 1,
      JSON.stringify(conn)
    );
  }

  // --- Apple: a spent per-connection budget leaves the remaining calendars due now ----------
  //
  // The budget clock is stubbed rather than waited out for real: the first two calls (the
  // deadline's own computation, then the check before the first calendar) read as "no time has
  // passed yet"; every call after that reads as "the budget is long gone" — deterministic,
  // regardless of how fast the machine running this script is.
  await clearAll();
  {
    const connId = await seedApple("sched-apple-budget");
    const sourceAId = await seedCalendarSource(connId, "cal-a", { lastSyncedAt: new Date(Date.now() - 2 * 60_000) });
    const sourceBId = await seedCalendarSource(connId, "cal-b", { lastSyncedAt: new Date(Date.now() - 60_000) });
    let clockCalls = 0;
    const deps: SyncDeps = {
      getAccessToken: async () => "unused",
      fetchPage: async () => emptyPage(),
      fetchApplePage: async ({ calendarUrl }) => emptyPage({ nextSyncToken: `${calendarUrl}-tok` }),
      budgetClock: () => (++clockCalls <= 2 ? 0 : Number.MAX_SAFE_INTEGER),
    };
    const stats = await runSyncPass({ deps });
    check("a spent budget reports itself", stats.budgetExhausted, JSON.stringify(stats));
    const conn = await readAppleConn(connId);
    check("a spent budget leaves remaining calendars due now", conn.next_sync_at !== null, String(conn.next_sync_at));
    const sourceA = await readSource(sourceAId);
    const sourceB = await readSource(sourceBId);
    check("the processed calendar's cursor advanced", sourceCursorOf(sourceA)?.syncToken === "cal-a-tok", JSON.stringify(sourceA?.sync_cursor));
    check("the un-started calendar's cursor did not", sourceCursorOf(sourceB) === null, JSON.stringify(sourceB?.sync_cursor));
  }

  await clearAll();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll sync-scheduler checks passed.");
});
