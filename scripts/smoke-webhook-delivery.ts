/**
 * Outbound webhook queueing, retry and — above all — SSRF.
 *
 * Delivery fetches a URL a user supplied, which makes this the one place in Orbit where a
 * user can point the server's own network position at a target of their choosing. The cloud
 * metadata endpoint is the classic prize: reachable only from inside, and it hands out
 * credentials to anything that asks. So the address checks are asserted exhaustively here,
 * including the forms that commonly slip past a naive filter.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { encrypt } from "../src/lib/crypto";
import {
  MAX_CONSECUTIVE_FAILURES,
  MAX_DELIVERY_ATTEMPTS,
  assertDeliverable,
  enqueueWebhookEvent,
  isBlockedAddress,
} from "../src/lib/webhooks/dispatch";

const USER = "webhook-smoke-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function blocked(url: string): Promise<boolean> {
  try {
    await assertDeliverable(url);
    return false;
  } catch {
    return true;
  }
}

async function seedEndpoint(opts: { url?: string; types?: string[]; status?: string } = {}) {
  const db = await getDb();
  const inserted = await db.execute(sql`
    INSERT INTO webhook_endpoints (user_id, url, secret_encrypted, event_types, status)
    VALUES (
      ${USER},
      ${opts.url ?? "https://example.com/hook"},
      ${encrypt("whsec_orbit_test")},
      ${JSON.stringify(opts.types ?? ["contact.created"])}::jsonb,
      ${opts.status ?? "active"}
    )
    RETURNING id
  `);
  return rowsOf<{ id: string }>(inserted)[0].id;
}

run(async () => {
  const db = await getDb();
  await db.execute(sql`DELETE FROM webhook_endpoints WHERE user_id = ${USER}`);

  // --- Address classification ----------------------------------------------------------------
  const mustBlock = [
    ["169.254.169.254", "the cloud metadata endpoint"],
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "RFC1918 10/8"],
    ["172.16.0.1", "RFC1918 172.16/12"],
    ["192.168.1.1", "RFC1918 192.168/16"],
    ["100.64.0.1", "CGNAT"],
    ["0.0.0.0", "this network"],
    ["::1", "IPv6 loopback"],
    ["fd00::1", "IPv6 unique local"],
    ["fe80::1", "IPv6 link local"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata address"],
    ["239.1.1.1", "multicast"],
    ["not-an-ip", "an unparseable address"],
  ] as const;
  for (const [ip, why] of mustBlock) {
    check(`blocks ${why} (${ip})`, isBlockedAddress(ip));
  }
  check("allows a public address", !isBlockedAddress("93.184.216.34"));
  check("allows a public IPv6 address", !isBlockedAddress("2606:2800:220:1:248:1893:25c8:1946"));

  // --- URL-level rules --------------------------------------------------------------------------
  check("rejects http://", await blocked("http://example.com/hook"));
  check("rejects credentials in the URL", await blocked("https://user:pass@example.com/hook"));
  check("rejects localhost", await blocked("https://localhost/hook"));
  check("rejects a .internal hostname", await blocked("https://vault.internal/hook"));
  check("rejects a .local hostname", await blocked("https://printer.local/hook"));
  check("rejects a literal metadata IP", await blocked("https://169.254.169.254/latest/meta-data/"));
  check("rejects a literal loopback IP", await blocked("https://127.0.0.1:8080/hook"));
  // The reason the check is at DELIVERY time and not only at registration: this hostname is
  // public in DNS terms but resolves into a private range.
  check(
    "rejects a public hostname that resolves to a private address",
    await blocked("https://localtest.me/hook")
  );

  // --- Queueing --------------------------------------------------------------------------------
  const endpointId = await seedEndpoint({});
  await enqueueWebhookEvent(USER, "contact.created", { id: "c1", name: "Ada" });
  const queued = rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM outbound_webhook_deliveries WHERE user_id = ${USER}
    `)
  )[0];
  check("an event is queued for a subscribed endpoint", Number(queued.n) === 1, String(queued.n));

  const row = rowsOf<{ event_id: string; status: string; payload: string | object }>(
    await db.execute(sql`
      SELECT event_id, status, payload FROM outbound_webhook_deliveries WHERE user_id = ${USER}
    `)
  )[0];
  check("it starts pending", row.status === "pending", row.status);
  check("it carries a stable event id", row.event_id.startsWith("evt_"), row.event_id);

  // Enqueue is idempotent on (endpoint_id, event_id), so a retried write cannot double-deliver.
  await db.execute(sql`
    INSERT INTO outbound_webhook_deliveries
      (user_id, endpoint_id, event_id, event_type, payload, status)
    VALUES (${USER}, ${endpointId}, ${row.event_id}, 'contact.created', '{}'::jsonb, 'pending')
    ON CONFLICT (endpoint_id, event_id) DO NOTHING
  `);
  const afterDup = rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM outbound_webhook_deliveries WHERE user_id = ${USER}
    `)
  )[0];
  check("re-queuing the same event is a no-op", Number(afterDup.n) === 1, String(afterDup.n));

  // --- Subscription filtering -------------------------------------------------------------------
  await db.execute(sql`DELETE FROM outbound_webhook_deliveries WHERE user_id = ${USER}`);
  await enqueueWebhookEvent(USER, "followup.due", { id: "c1" });
  const unsubscribed = rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM outbound_webhook_deliveries WHERE user_id = ${USER}
    `)
  )[0];
  check(
    "an event the endpoint did not subscribe to is not queued",
    Number(unsubscribed.n) === 0,
    String(unsubscribed.n)
  );

  // --- A disabled endpoint receives nothing --------------------------------------------------------
  await db.execute(sql`UPDATE webhook_endpoints SET status = 'disabled' WHERE id = ${endpointId}`);
  await enqueueWebhookEvent(USER, "contact.created", { id: "c2" });
  const whileDisabled = rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM outbound_webhook_deliveries WHERE user_id = ${USER}
    `)
  )[0];
  check("a disabled endpoint is skipped", Number(whileDisabled.n) === 0, String(whileDisabled.n));

  // A pending endpoint has not completed its verification handshake yet.
  await db.execute(sql`UPDATE webhook_endpoints SET status = 'pending' WHERE id = ${endpointId}`);
  await enqueueWebhookEvent(USER, "contact.created", { id: "c3" });
  const whilePending = rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM outbound_webhook_deliveries WHERE user_id = ${USER}
    `)
  )[0];
  check("an unverified endpoint is skipped", Number(whilePending.n) === 0, String(whilePending.n));

  check("the retry ladder is bounded", MAX_DELIVERY_ATTEMPTS > 0 && MAX_DELIVERY_ATTEMPTS <= 10);
  check("endpoints are disabled after repeated failure", MAX_CONSECUTIVE_FAILURES >= 3);

  await db.execute(sql`DELETE FROM webhook_endpoints WHERE user_id = ${USER}`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll webhook delivery checks passed.");
});
