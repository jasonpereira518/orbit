/**
 * Disconnecting an integration removes what the dialog says it removes, whoever does it.
 *
 *   1. Luma / Eventbrite "also delete": the events the sync created go, with their guest lists,
 *      company links and alias rows; events from another provider or added by hand stay.
 *   2. The admin's "disconnect integration" runs the same sequence as the user's own Google
 *      disconnect (provider-disconnect.ts): connection row, calendar sources and the
 *      confirmation-email scan row all go. It used to delete the connection row only.
 *
 * Run: npx tsx scripts/smoke-disconnect-parity.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { deleteSyncedProviderEvents } from "../src/lib/events/connections";
import { disconnectGoogleForUser } from "../src/lib/provider-disconnect";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const U = "user_disconnect_parity";

async function main() {
  const db = await getDb();
  const q = async (query: ReturnType<typeof sql>) => rowsOf<Record<string, unknown>>(await db.execute(query));
  const n = async (query: ReturnType<typeof sql>) => Number((await q(query))[0]?.n ?? 0);

  console.log("Luma: also delete what was synced");
  const make = async (title: string, provider: string | null) => {
    const [ev] = await q(sql`INSERT INTO events (user_id, title, provider) VALUES (${U}, ${title}, ${provider}) RETURNING id`);
    await q(sql`INSERT INTO event_attendees (event_id, user_id, full_name, email, phone, identity_key)
                VALUES (${ev.id as string}::uuid, ${U}, ${`Guest of ${title}`}, 'guest@example.test', '+1 555 0100', ${`k-${title}`})`);
    await q(sql`INSERT INTO event_aliases (user_id, event_id, kind, value, source) VALUES (${U}, ${ev.id as string}::uuid, 'url', ${`https://lu.ma/${title}`}, 'luma')`);
    return ev.id as string;
  };
  const luma = await make("luma-hosted", "luma");
  const eventbrite = await make("eventbrite-hosted", "eventbrite");
  const manual = await make("added-by-hand", null);

  const deleted = await deleteSyncedProviderEvents(U, "luma");
  check("one Luma event deleted", deleted === 1);
  check("its guest list is gone", (await n(sql`SELECT count(*)::int AS n FROM event_attendees WHERE event_id = ${luma}::uuid`)) === 0);
  check("its alias rows are gone (they survive an event otherwise)", (await n(sql`SELECT count(*)::int AS n FROM event_aliases WHERE value = 'https://lu.ma/luma-hosted'`)) === 0);
  check("the Eventbrite event and its guests stay", (await n(sql`SELECT count(*)::int AS n FROM event_attendees WHERE event_id = ${eventbrite}::uuid`)) === 1);
  check("the hand-added event stays", (await n(sql`SELECT count(*)::int AS n FROM events WHERE id = ${manual}::uuid`)) === 1);
  check("nothing more to delete the second time", (await deleteSyncedProviderEvents(U, "luma")) === 0);

  console.log("\nGoogle: the shared disconnect (also what the admin runs)");
  const [conn] = await q(sql`INSERT INTO gmail_connections (user_id, email_address, access_token_encrypted, refresh_token_encrypted)
                             VALUES (${U}, 'u@gmail.test', 'not-real-ciphertext', 'not-real-ciphertext') RETURNING id`);
  await q(sql`INSERT INTO calendar_sources (user_id, provider, connection_id, calendar_id) VALUES (${U}, 'google', ${conn.id as string}::uuid, 'primary')`);
  await q(sql`INSERT INTO event_provider_connections (user_id, provider, auth_kind) VALUES (${U}, 'gmail', 'borrowed')`);
  await disconnectGoogleForUser(U);
  check("the connection row is gone", (await n(sql`SELECT count(*)::int AS n FROM gmail_connections WHERE user_id = ${U}`)) === 0);
  check("its calendar sources are gone", (await n(sql`SELECT count(*)::int AS n FROM calendar_sources WHERE user_id = ${U} AND provider = 'google'`)) === 0);
  check("the confirmation-email scan row is gone", (await n(sql`SELECT count(*)::int AS n FROM event_provider_connections WHERE user_id = ${U} AND provider = 'gmail'`)) === 0);
  check("events stay (nothing imported is deleted unless asked)", (await n(sql`SELECT count(*)::int AS n FROM events WHERE user_id = ${U}`)) === 2);

  if (failures > 0) throw new Error(`${failures} disconnect-parity check(s) failed`);
  console.log("\nAll disconnect-parity checks passed.");
}

run(main);
