/**
 * Every registered connector must be answerable by the status action, or the dialog renders
 * a card with no state — the exact drift the registry exists to prevent.
 *
 * The list half of that (registry ids ↔ `CONNECTOR_STATUS_LOOKUP_IDS`) is a comparison of two
 * arrays. The half that was missing is the one that matters: this script never imported
 * `getIntegrationStatuses` at all, and the action back-fills any id it did not produce with
 * `{ state: "off", detail: "Not connected" }`. So a lookup that was deleted, renamed or threw
 * reported a plausible "Not connected" — indistinguishable from a real answer — and the commit
 * titled "Answer for every registered connector in the integration statuses" was true by
 * construction and verified by nothing.
 *
 * Hence the live section below: seed each connector's backing state so that its REAL lookup
 * produces something the back-fill cannot, then assert that. pglite tier for that reason.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { CONNECTORS } from "../src/lib/connectors/registry";
import { CONNECTOR_STATUS_LOOKUP_IDS } from "../src/lib/connectors/status";
import { getDb } from "../src/db";
import { encrypt } from "../src/lib/crypto";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "demo-user";

for (const connector of CONNECTORS) {
  const has = (CONNECTOR_STATUS_LOOKUP_IDS as readonly string[]).includes(connector.id);
  if (connector.availability === "planned") {
    check(`${connector.id}: planned connectors need no lookup`, !has);
    continue;
  }
  check(`${connector.id}: has a status lookup`, has);
}

for (const id of CONNECTOR_STATUS_LOOKUP_IDS) {
  check(`${id}: the lookup names a registered connector`, CONNECTORS.some((c) => c.id === id));
}

run(async () => {
  // `getIntegrationStatuses` calls `requireUserId()`, which needs either real Clerk auth or
  // Orbit's demo-mode identity — the same trick `scripts/smoke-api-connector-routes-live.ts`
  // and `smoke-follow-up-actions.ts` use to call server actions from a script.
  // `ORBIT_DEMO_DATA=off` skips seeding the demo workspace, which would only slow this down.
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  (process.env as Record<string, string>).NODE_ENV = "development";
  process.env.ORBIT_DEMO_DATA = "off";
  // Google and Microsoft report `{ state: "off", detail: "Unavailable" }` when their OAuth app
  // is unconfigured — which is neither the seeded answer nor the back-fill's, so the checks
  // below could not tell those apart either. Configure both so the connection rows are read.
  process.env.GOOGLE_CLIENT_ID = "smoke-client";
  process.env.GOOGLE_CLIENT_SECRET = "smoke-secret";
  process.env.GOOGLE_REDIRECT_URI = "https://orbit.test/api/gmail/callback";
  process.env.MICROSOFT_CLIENT_ID = "smoke-client";
  process.env.MICROSOFT_CLIENT_SECRET = "smoke-secret";
  process.env.MICROSOFT_REDIRECT_URI = "https://orbit.test/api/outlook/callback";

  // Imported after the env is set: `getIntegrationStatuses` is a `"use server"` module whose
  // import graph reaches the Clerk and OAuth config readers.
  const { getIntegrationStatuses } = await import("../src/actions/integrations");

  const db = await getDb();
  const cleanup = async () => {
    for (const table of [
      "api_keys",
      "user_settings",
      "calendar_subscriptions",
      "event_provider_connections",
      "gmail_connections",
      "outlook_connections",
    ]) {
      await db.execute(sql.raw(`DELETE FROM ${table} WHERE user_id = '${USER}'`));
    }
  };
  await cleanup();

  console.log("\nevery lookup really runs (a deleted one back-fills as 'Not connected')");
  // One distinctive, seeded answer per connector id. None of these is the back-fill's
  // "Not connected", so an id reporting that string is a lookup that did not run.
  await db.execute(sql`
    INSERT INTO api_keys (user_id, name, kind, prefix, key_hash, scopes)
    VALUES (${USER}, 'statuses smoke', 'api', 'orb_smoke', 'hash-smoke', '["read"]'::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO user_settings (user_id, apollo_api_key_encrypted)
    VALUES (${USER}, ${encrypt("apollo-key")})
    ON CONFLICT (user_id) DO UPDATE SET apollo_api_key_encrypted = excluded.apollo_api_key_encrypted
  `);
  await db.execute(sql`
    INSERT INTO calendar_subscriptions (user_id, label, ics_url, last_sync_status)
    VALUES (${USER}, 'Team calendar', 'https://example.com/feed.ics', 'ok')
  `);
  for (const provider of ["luma", "eventbrite"]) {
    await db.execute(sql`
      INSERT INTO event_provider_connections (user_id, provider, auth_kind, status, api_key_encrypted)
      VALUES (${USER}, ${provider}, 'api_key', 'active', ${encrypt("provider-secret")})
    `);
  }
  await db.execute(sql`
    INSERT INTO gmail_connections (user_id, email_address, status, access_token_encrypted, refresh_token_encrypted)
    VALUES (${USER}, 'demo@example.com', 'active', ${encrypt("access")}, ${encrypt("refresh")})
  `);
  await db.execute(sql`
    INSERT INTO outlook_connections (user_id, email_address, status, access_token_encrypted, refresh_token_encrypted)
    VALUES (${USER}, 'demo@example.com', 'active', ${encrypt("access")}, ${encrypt("refresh")})
  `);

  const statuses = await getIntegrationStatuses();

  const EXPECTED: Record<string, string> = {
    google: "Connected",
    outlook: "Connected",
    linkedin: "Not imported yet",
    calendar_ics: "1 feed",
    luma: "Connected",
    eventbrite: "Connected",
    apollo: "Key saved",
    zapier: "1 key",
  };
  for (const id of CONNECTOR_STATUS_LOOKUP_IDS) {
    const status = statuses.connectors[id];
    check(
      `${id}: its own lookup answered, not the back-fill`,
      status !== undefined &&
        status !== "unknown" &&
        status.detail === EXPECTED[id],
      JSON.stringify(status)
    );
  }
  // The back-fill still has a job — an id with no lookup at all must not be missing from the
  // map — but it must never be what a registered connector's answer comes from. Prove the
  // sentinel it writes is absent from a fully-seeded workspace.
  const backFilled = CONNECTOR_STATUS_LOOKUP_IDS.filter((id) => {
    const s = statuses.connectors[id];
    return s !== undefined && s !== "unknown" && s.detail === "Not connected";
  });
  check("no registered connector fell through to the back-fill", backFilled.length === 0, backFilled.join(","));

  await cleanup();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll integration status checks passed.");
});
