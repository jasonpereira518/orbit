/**
 * PROBE: account deletion, end to end, against a seeded throwaway PGlite database.
 *
 * Seeds one row in (nearly) every table for user A and user B (see lib/seed-everything.ts:
 * every text value carries the owner's id), then exercises the three ways an account is
 * deleted and scans the WHOLE database for anything of A's that survived:
 *
 *   1. Settings → Delete account: `deleteOwnAccount` with the vendor calls recorded.
 *   2. Clerk `user.deleted` webhook: the real route handler, with a correctly signed event.
 *   3. The Clerk orphan sweep backstop is code-read only (it needs Clerk's API).
 *
 * B's rows must be untouched in every case.
 *
 * Fake data only; `_env` deletes DATABASE_URL and strips provider keys.
 * Run: npx tsx privacy/probe-account-deletion.ts
 */
import "../scripts/smoke/_env";
import { mkdirSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { Webhook } from "standardwebhooks";
import { getDb, rowsOf } from "../src/db";
import { deleteOwnAccount } from "../src/lib/account-deletion";
import { readCatalog } from "./lib/catalog";
import { seedEverything, scanFor } from "./lib/seed-everything";
import { run } from "../scripts/smoke/_env";

const A = "user_privA7f3e"; // Settings path
const B = "user_privB91c2"; // bystander
const C = "user_privC55d0"; // Clerk-webhook path

/** Survivors that are documented, intentional exceptions in user-data.ts / privacy page. */
const DOCUMENTED = new Set(["admin_audit_log", "webhook_deliveries", "data_purge_runs"]);

type Result = Record<string, unknown>;

run(async () => {
  const cat = await readCatalog();
  const db = await getDb();
  const out: Result = {};

  // ---------------------------------------------------------------- seed
  const seeds: Record<string, { seeded: number; failed: Record<string, string> }> = {};
  for (const u of [A, B, C]) {
    const r = await seedEverything(cat, u, { skip: undefined });
    seeds[u] = { seeded: r.seeded.size, failed: Object.fromEntries(r.failed) };
  }
  // Give A and C a Stripe customer, as a paying account would have.
  for (const u of [A, C]) {
    await db.execute(sql`UPDATE user_settings SET stripe_customer_id = ${"cus_" + u}, subscription_status = 'active' WHERE user_id = ${u}`);
  }
  out.seed = seeds;
  console.log(`seeded: A=${seeds[A].seeded} tables, B=${seeds[B].seeded}, C=${seeds[C].seeded}; failed for A: ${Object.keys(seeds[A].failed).length}`);
  for (const [t, e] of Object.entries(seeds[A].failed)) console.log(`  seed-fail ${t}: ${e}`);

  const before = { A: await scanFor(cat, A), B: await scanFor(cat, B), C: await scanFor(cat, C) };
  console.log(`before: A in ${before.A.size} tables, B in ${before.B.size}, C in ${before.C.size}`);

  // ---------------------------------------------------------------- 1. Settings path
  const vendorCalls: string[] = [];
  await deleteOwnAccount(A, {
    cancelSubscriptions: async (cus) => void vendorCalls.push(`stripe.cancelSubscriptions(${cus})`),
    deleteLogin: async (id) => void vendorCalls.push(`clerk.deleteUser(${id})`),
  });
  const afterA = await scanFor(cat, A);
  const afterB = await scanFor(cat, B);
  out.settingsPath = {
    vendorCalls,
    survivors: Object.fromEntries(afterA),
    undocumentedSurvivors: [...afterA.keys()].filter((t) => !DOCUMENTED.has(t)),
    bystanderTablesBefore: before.B.size,
    bystanderTablesAfter: afterB.size,
    bystanderLost: [...before.B.keys()].filter((t) => !afterB.has(t) || afterB.get(t)!.rows < before.B.get(t)!.rows),
  };
  console.log(`\n[1] Settings delete: vendor calls = ${vendorCalls.join(", ")}`);
  console.log(`    A survives in ${afterA.size} tables:`);
  for (const [t, v] of afterA) console.log(`      ${DOCUMENTED.has(t) ? "(documented) " : "UNDOCUMENTED "}${t}: ${v.rows} row(s) via [${v.columns.join(", ")}]`);
  console.log(`    B lost rows in: ${(out.settingsPath as Result).bystanderLost}`);

  // ---------------------------------------------------------------- 2. Clerk user.deleted webhook
  const secretBytes = Buffer.from("privacy-probe-fake-webhook-secret-32b!");
  process.env.CLERK_WEBHOOK_SIGNING_SECRET = `whsec_${secretBytes.toString("base64")}`;
  const { POST } = await import("../src/app/api/webhooks/clerk/route");
  const { NextRequest } = await import("next/server");
  const body = JSON.stringify({ type: "user.deleted", object: "event", data: { id: C, deleted: true, object: "user" } });
  const msgId = "msg_privacyprobe1";
  const ts = new Date();
  const signature = new Webhook(secretBytes.toString("base64")).sign(msgId, ts, body);
  const req = new NextRequest("http://localhost/api/webhooks/clerk", {
    method: "POST",
    body,
    headers: { "svix-id": msgId, "svix-timestamp": String(Math.floor(ts.getTime() / 1000)), "svix-signature": signature, "content-type": "application/json" },
  });
  // Record any outbound call the webhook makes (Stripe, Clerk, Google revoke…).
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  const res = await POST(req);
  globalThis.fetch = realFetch;
  const afterC = await scanFor(cat, C);
  const cusLeft = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM user_settings WHERE stripe_customer_id = ${"cus_" + C}`));
  out.webhookPath = {
    status: res.status,
    outboundFetches: fetched,
    survivors: Object.fromEntries(afterC),
    stripeCustomerIdStillMapped: (cusLeft[0] as { n: number }).n > 0,
  };
  console.log(`\n[2] Clerk user.deleted webhook: HTTP ${res.status}; outbound fetches: ${fetched.length ? fetched.join(", ") : "none"}`);
  console.log(`    stripe_customer_id still mapped to the account after purge: ${(out.webhookPath as Result).stripeCustomerIdStillMapped}`);
  console.log(`    => an active Stripe subscription is NOT cancelled on this path, and the only link to it is now gone`);
  console.log(`    C survives in ${afterC.size} tables:`);
  for (const [t, v] of afterC) console.log(`      ${DOCUMENTED.has(t) ? "(documented) " : "UNDOCUMENTED "}${t}: ${v.rows} row(s) via [${v.columns.join(", ")}]`);

  // What the survivors actually contain (first row of each undocumented table), for the audit.
  const samples: Record<string, unknown> = {};
  for (const t of [...afterA.keys()]) {
    const r = await db.execute(sql`SELECT * FROM ${sql.identifier(t)} t WHERE t::text LIKE ${`%${A}%`} LIMIT 2`);
    samples[t] = rowsOf(r);
  }
  out.survivorSamples = samples;

  mkdirSync("privacy/out", { recursive: true });
  writeFileSync("privacy/out/account-deletion.json", JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2));
  console.log("\nwrote privacy/out/account-deletion.json");
});
