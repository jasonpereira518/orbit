import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { runSyncPass, type SyncDeps } from "../src/lib/sync-scheduler";

/**
 * Google Contacts sync inside the Google lane.
 *
 * The property this exists for is the one the schema's own comment warns about: `sync_cursor`
 * is a single jsonb column, and a capability that writes only its own key over the whole
 * object erases the other capability's position — silently, twice an hour, forever. Calendar
 * and contacts now share a lane precisely so ONE merged write happens per connection, and
 * that is what these checks pin.
 *
 * The scope gating matters for the same class of reason: a contacts-only grant is a working
 * connection, and the pre-existing "no calendar scope, disarm" rule would have switched it
 * off for lacking a capability it never claimed.
 */
const CALENDAR = "https://www.googleapis.com/auth/calendar.readonly";
const CONTACTS = "https://www.googleapis.com/auth/contacts.readonly";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Cursor = {
  calendar?: { syncToken?: string | null; pageToken?: string | null } | null;
  contacts?: { syncToken?: string | null; pageToken?: string | null } | null;
  luma?: unknown;
};

async function seed(userId: string, scopes: string, cursor: Cursor | null): Promise<string> {
  const db = await getDb();
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id = ${userId}`);
  const inserted = await db.execute(sql`
    INSERT INTO gmail_connections
      (user_id, email_address, access_token_encrypted, status, scopes, next_sync_at,
       sync_failures, sync_cursor)
    VALUES (${userId}, ${userId + "@example.com"}, 'enc', 'active', ${scopes},
            ${new Date(Date.now() - 60_000)}, 0,
            ${cursor === null ? null : JSON.stringify(cursor)}::jsonb)
    RETURNING id
  `);
  return rowsOf<{ id: string }>(inserted)[0].id;
}

async function readCursor(id: string): Promise<Cursor | null> {
  const db = await getDb();
  const row = rowsOf<{ sync_cursor: Cursor | string | null; sync_error: string | null; next_sync_at: unknown }>(
    await db.execute(sql`SELECT sync_cursor, sync_error, next_sync_at FROM gmail_connections WHERE id = ${id}`)
  )[0];
  const raw = row?.sync_cursor ?? null;
  return typeof raw === "string" ? (JSON.parse(raw) as Cursor) : raw;
}

async function readRow(id: string) {
  const db = await getDb();
  return rowsOf<{ next_sync_at: string | null; sync_error: string | null; status: string }>(
    await db.execute(sql`SELECT next_sync_at, sync_error, status FROM gmail_connections WHERE id = ${id}`)
  )[0];
}

/** Only this script's connections may be armed, or another script's rows join the pass. */
async function isolate(users: string[]) {
  const db = await getDb();
  await db.execute(sql`UPDATE gmail_connections SET next_sync_at = NULL`);
  await db.execute(sql`UPDATE outlook_connections SET next_sync_at = NULL`);
  for (const u of users) {
    await db.execute(sql`UPDATE gmail_connections SET next_sync_at = ${new Date(Date.now() - 60_000)} WHERE user_id = ${u}`);
  }
}

function depsFor(
  contactPages: Array<{ people: never[]; nextSyncToken: string | null; nextPageToken: string | null }>
): { deps: SyncDeps } {
  const state = { contactCalls: 0 };
  const deps: SyncDeps = {
    getAccessToken: async (userId: string) => `stub-token:${userId}`,
    fetchPage: async () => ({
      events: [],
      nextSyncToken: "cal-fresh",
      nextPageToken: null,
      tombstones: 0,
      selfEmails: [],
    }),
    fetchContactsPage: async () => {
      const page = contactPages[Math.min(state.contactCalls, contactPages.length - 1)];
      state.contactCalls++;
      return { tombstones: 0, nameless: 0, ...page };
    },
  };
  return { deps };
}

run(async () => {
  console.log("both capabilities: one merged cursor, neither key erased");
  {
    const user = "gc-both";
    const id = await seed(user, `${CALENDAR} ${CONTACTS}`, { contacts: { syncToken: "contacts-old" } });
    await isolate([user]);
    const { deps } = depsFor([{ people: [], nextSyncToken: "contacts-fresh", nextPageToken: null }]);
    const stats = await runSyncPass({ deps });
    check("the connection synced", stats.synced === 1, JSON.stringify({ synced: stats.synced }));

    const cursor = await readCursor(id);
    check("the calendar cursor was written", cursor?.calendar?.syncToken === "cal-fresh", JSON.stringify(cursor));
    check("the contacts cursor was written", cursor?.contacts?.syncToken === "contacts-fresh", JSON.stringify(cursor));
  }

  console.log("\nan unrelated key on the cursor survives the run");
  {
    const user = "gc-foreign";
    const id = await seed(user, `${CALENDAR} ${CONTACTS}`, { luma: { cursor: "keep-me" } });
    await isolate([user]);
    const { deps } = depsFor([{ people: [], nextSyncToken: "c2", nextPageToken: null }]);
    await runSyncPass({ deps });
    const cursor = await readCursor(id);
    check("a key this lane does not own is untouched", JSON.stringify(cursor?.luma) === JSON.stringify({ cursor: "keep-me" }), JSON.stringify(cursor));
  }

  console.log("\na contacts-only grant is a working connection, not a disarmed one");
  {
    const user = "gc-contacts-only";
    const id = await seed(user, CONTACTS, null);
    await isolate([user]);
    const { deps } = depsFor([{ people: [], nextSyncToken: "c3", nextPageToken: null }]);
    const stats = await runSyncPass({ deps });
    check("it is not counted as out of scope", stats.skippedNoScope === 0, String(stats.skippedNoScope));
    const row = await readRow(id);
    check("it stays armed", row.next_sync_at !== null);
    check("no disarm reason was written", !row.sync_error, String(row.sync_error));
    const cursor = await readCursor(id);
    check("contacts still synced", cursor?.contacts?.syncToken === "c3", JSON.stringify(cursor));
    check("no calendar cursor was invented", !cursor?.calendar?.syncToken, JSON.stringify(cursor));
  }

  console.log("\na grant with neither capability is disarmed");
  {
    const user = "gc-neither";
    const id = await seed(user, "https://www.googleapis.com/auth/gmail.readonly", null);
    await isolate([user]);
    const { deps } = depsFor([{ people: [], nextSyncToken: "unused", nextPageToken: null }]);
    const stats = await runSyncPass({ deps });
    check("it is counted as out of scope", stats.skippedNoScope === 1, String(stats.skippedNoScope));
    const row = await readRow(id);
    check("it is unscheduled", row.next_sync_at === null);
    check("the reason names both capabilities", (row.sync_error ?? "").includes("contacts"), String(row.sync_error));
  }

  const db = await getDb();
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id LIKE 'gc-%'`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Google Contacts sync checks passed.");
});
