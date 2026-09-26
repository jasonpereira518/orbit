/**
 * Outbound webhook drains claim their rows (`drainDueDeliveries`).
 *
 * The drain used to SELECT due deliveries and send them one by one. Two drains that
 * overlapped (a slow scheduled run and the next, or a manual run) each read the same rows
 * and delivered the same event twice. Rows are now claimed with FOR UPDATE SKIP LOCKED in
 * the statement that reads them, and pushed past `now` for the length of the attempt.
 *
 * No network: the endpoint is a public IP literal (no DNS) and fetch is stubbed.
 * Local PGlite. Run: npx tsx scripts/smoke-webhook-drain-claim.ts
 */
import "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { encrypt } from "../src/lib/crypto";
import { drainDueDeliveries } from "../src/lib/webhooks/dispatch";

const USER = "smoke-drain-claim";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM webhook_endpoints WHERE user_id = ${USER}`);
  const [endpoint] = rowsOf<{ id: string }>(await db.execute(sql`
    INSERT INTO webhook_endpoints (user_id, url, secret_encrypted, event_types, status)
    VALUES (${USER}, 'https://93.184.216.34/hook', ${encrypt("whsec_smoke")}, '["contact.created"]'::jsonb, 'active')
    RETURNING id`));
  const past = new Date(Date.now() - 60_000);
  for (let i = 0; i < 12; i++) {
    await db.execute(sql`
      INSERT INTO outbound_webhook_deliveries (user_id, endpoint_id, event_id, event_type, payload, status, next_attempt_at)
      VALUES (${USER}, ${endpoint!.id}, ${`evt-${i}`}, 'contact.created', ${JSON.stringify({ n: i })}::jsonb, 'pending', ${past})`);
  }

  const sends: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sends.push(String(init?.body ?? ""));
    await new Promise((r) => setTimeout(r, 30));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const [a, b] = await Promise.all([
    drainDueDeliveries({ budgetMs: 20_000, max: 50 }),
    drainDueDeliveries({ budgetMs: 20_000, max: 50 }),
  ]);
  globalThis.fetch = realFetch;

  check("two overlapping drains send each delivery exactly once", sends.length === 12 && new Set(sends).size === 12, `${sends.length} sends, ${new Set(sends).size} distinct`);
  check("and split the work rather than repeat it", a.attempted + b.attempted === 12, JSON.stringify({ a, b }));
  const delivered = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM outbound_webhook_deliveries WHERE endpoint_id = ${endpoint!.id} AND status = 'delivered'`))[0]!.n;
  check("every one is marked delivered", delivered === 12, String(delivered));

  await db.execute(sql`DELETE FROM webhook_endpoints WHERE user_id = ${USER}`);
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll webhook drain claim checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
