/**
 * One hanging webhook endpoint next to a healthy one: how many of the healthy endpoint's
 * deliveries land in one drain tick, and how long the tick takes.
 *
 * Local PGlite, stubbed fetch (the slow host waits out the attempt timeout).
 * Run: npx tsx scripts/dev/perf/webhook-drain-bench.ts
 */
import "../../smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../../../src/db";
import { encrypt } from "../../../src/lib/crypto";
import { drainDueDeliveries } from "../../../src/lib/webhooks/dispatch";

const USER = "webhook-drain-bench-user";
const SLOW = "https://1.1.1.1/hook";
const FAST = "https://8.8.8.8/hook";

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === SLOW) {
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted due to timeout")));
    });
  }
  return new Response("ok", { status: 200 });
}) as typeof fetch;

async function main() {
  // AbortSignal.timeout's timer is unref'd: without this, node exits mid-drain once only the
  // hanging request is left.
  const keepAlive = setInterval(() => {}, 1000);
  const db = await getDb();
  await db.execute(sql`DELETE FROM webhook_endpoints WHERE user_id = ${USER}`);
  const ids: Record<string, string> = {};
  for (const url of [SLOW, FAST]) {
    const r = await db.execute(sql`
      INSERT INTO webhook_endpoints (user_id, url, secret_encrypted, event_types, status)
      VALUES (${USER}, ${url}, ${encrypt("whsec_bench")}, '["contact.created"]'::jsonb, 'active') RETURNING id`);
    ids[url] = rowsOf<{ id: string }>(r)[0].id;
  }
  // Interleaved and slow-first, so a one-at-a-time drain meets the slow endpoint first.
  for (let i = 0; i < 10; i++) {
    for (const url of [SLOW, FAST]) {
      await db.execute(sql`
        INSERT INTO outbound_webhook_deliveries (user_id, endpoint_id, event_id, event_type, payload, status, attempts, next_attempt_at)
        VALUES (${USER}, ${ids[url]}, ${`bench-${url}-${i}`}, 'contact.created', '{}'::jsonb, 'pending', 0, now() - ${`${100 - i * 2 - (url === SLOW ? 1 : 0)} seconds`}::interval)`);
    }
  }
  const started = Date.now();
  const stats = await drainDueDeliveries({ budgetMs: 40_000, max: 200 });
  const ms = Date.now() - started;
  const fast = rowsOf<{ n: number }>(await db.execute(sql`
    SELECT count(*)::int AS n FROM outbound_webhook_deliveries WHERE endpoint_id = ${ids[FAST]} AND status = 'delivered'`))[0].n;
  console.log(JSON.stringify({ ms, ...stats, healthyDelivered: `${fast}/10` }));
  await db.execute(sql`DELETE FROM webhook_endpoints WHERE user_id = ${USER}`);
  clearInterval(keepAlive);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
