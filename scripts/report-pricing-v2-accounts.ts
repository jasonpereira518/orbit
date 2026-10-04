/**
 * Pricing v2, checkpoint 0: the accounts that need a human decision before the new plans ship.
 *
 * READ-ONLY. Run it against production yourself:
 *
 *   DATABASE_URL=<prod> STRIPE_SECRET_KEY=<live key, a read-only restricted key is enough> \
 *     npx tsx scripts/report-pricing-v2-accounts.ts
 *
 * Why it looks the way it does:
 *  - It uses the raw `neon()` driver and never imports `@/db`: `getDb()` runs `reconcileSchema()`
 *    on first use, so importing it with a prod URL would MIGRATE production.
 *  - Every SQL statement is a SELECT, sent as one read-only transaction per query
 *    (`readOnly: true`), so Postgres itself refuses a write even if one were added by mistake.
 *  - Stripe calls are `list` / `retrieve` only. A restricted key with read access to
 *    Subscriptions, Prices, Products and Customers is all it needs.
 *
 * Sections:
 *  (a) active live subscriptions, grouped by price, flagging the old Pro $5/mo and $50/yr prices
 *  (b) comped accounts (invite comps carry the note "Invited by an admin")
 *  (c) accounts that resolve to Pro and still have un-revoked REST API keys or live webhook endpoints
 *  (d) Lifetime purchasers, for context
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { neon } from "@neondatabase/serverless";
import Stripe from "stripe";

type Row = Record<string, unknown>;

function section(title: string) {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

function table(rows: Row[]) {
  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }
  console.table(rows);
}

/**
 * The plan every gate would resolve, in SQL: comp > lifetime purchase > live subscription >
 * free. Mirrors `resolvePlan` in src/lib/entitlements.ts (a subscription counts while it is
 * `active`, or while its paid period has not ended).
 */
const RESOLVED_PLAN_SQL = `
  CASE
    WHEN s.comped_plan IS NOT NULL THEN s.comped_plan
    WHEN s.lifetime_purchased_at IS NOT NULL THEN 'lifetime'
    WHEN s.subscription_plan IS NOT NULL
      AND (s.subscription_status = 'active' OR s.subscription_period_end > now())
      THEN s.subscription_plan
    ELSE 'free'
  END`;

async function databaseSections() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("\nDATABASE_URL is not set, so sections (b)-(d) were skipped.");
    return;
  }
  const host = url.replace(/^.*@([^/:]+).*$/, "$1");
  console.log(`Database host: ${host}`);
  if (host.includes("ep-delicate-brook")) {
    console.log(
      "WARNING: this is the local fixture database (every .env.local points at it), not production."
    );
  }
  const sql = neon(url);
  const read = (text: string) =>
    sql.transaction([sql.query(text)], { readOnly: true }).then((r) => r[0] as Row[]);

  section("(b) Comped accounts");
  table(
    await read(`
      SELECT s.user_id, s.email, s.comped_plan, s.comped_note, s.comped_at, s.comped_by,
             s.subscription_status AS also_subscribed
        FROM user_settings s
       WHERE s.comped_plan IS NOT NULL
       ORDER BY s.comped_at NULLS LAST`)
  );

  section("(c) Pro accounts with REST API keys or webhook endpoints (API becomes Max-only)");
  table(
    await read(`
      SELECT s.user_id, s.email, ${RESOLVED_PLAN_SQL} AS plan,
             CASE WHEN s.comped_plan IS NOT NULL THEN 'comp' ELSE 'subscription' END AS source,
             (SELECT count(*) FROM api_keys k
               WHERE k.user_id = s.user_id AND k.kind = 'api' AND k.revoked_at IS NULL)::int
               AS live_api_keys,
             (SELECT count(*) FROM webhook_endpoints w
               WHERE w.user_id = s.user_id AND w.status <> 'disabled')::int
               AS live_webhook_endpoints
        FROM user_settings s
       WHERE ${RESOLVED_PLAN_SQL} = 'orbit'
         AND (EXISTS (SELECT 1 FROM api_keys k
                       WHERE k.user_id = s.user_id AND k.kind = 'api' AND k.revoked_at IS NULL)
              OR EXISTS (SELECT 1 FROM webhook_endpoints w
                          WHERE w.user_id = s.user_id AND w.status <> 'disabled'))
       ORDER BY s.user_id`)
  );

  section("(d) Lifetime purchasers (context: they move to Max features on their own key)");
  table(
    await read(`
      SELECT s.user_id, s.email, s.lifetime_purchased_at, s.comped_plan
        FROM user_settings s
       WHERE s.lifetime_purchased_at IS NOT NULL
       ORDER BY s.lifetime_purchased_at`)
  );

  section("Plan distribution today");
  table(
    await read(`
      SELECT ${RESOLVED_PLAN_SQL} AS plan,
             CASE WHEN s.comped_plan IS NOT NULL THEN 'comp'
                  WHEN s.lifetime_purchased_at IS NOT NULL THEN 'purchase'
                  WHEN s.subscription_plan IS NOT NULL THEN 'subscription'
                  ELSE 'free' END AS source,
             count(*)::int AS accounts
        FROM user_settings s
       GROUP BY 1, 2
       ORDER BY 1, 2`)
  );
}

async function stripeSection() {
  section("(a) Active Stripe subscriptions by price");
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.log("  STRIPE_SECRET_KEY is not set, so this section was skipped.");
    return;
  }
  const mode = /^(sk|rk)_live_/.test(key) ? "LIVE" : "TEST";
  console.log(`  Stripe mode: ${mode}`);
  const stripe = new Stripe(key);

  const rows: Row[] = [];
  for (const status of ["active", "trialing", "past_due"] as const) {
    for await (const sub of stripe.subscriptions.list({
      status,
      limit: 100,
      expand: ["data.items.data.price"],
    })) {
      for (const item of sub.items.data) {
        const price = item.price;
        const amount = price.unit_amount ?? 0;
        const interval = price.recurring?.interval ?? "one_time";
        const legacy =
          (amount === 500 && interval === "month") || (amount === 5000 && interval === "year");
        rows.push({
          subscription: sub.id,
          customer: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
          orbit_user_id: sub.metadata?.orbit_user_id ?? "",
          status: sub.status,
          price: price.id,
          amount: `$${(amount / 100).toFixed(2)}/${interval}`,
          old_price: legacy ? "YES" : "",
          cancel_at_period_end: sub.cancel_at_period_end ? "yes" : "",
          discount: sub.discounts?.length ? "yes" : "",
        });
      }
    }
  }
  table(rows);
  const legacyCount = rows.filter((r) => r.old_price === "YES").length;
  console.log(`  ${rows.length} subscription item(s); ${legacyCount} on an old Pro price.`);

  section("Stripe prices on file (what the live script would archive)");
  const prices: Row[] = [];
  for await (const price of stripe.prices.list({ limit: 100, expand: ["data.product"] })) {
    const product = price.product as Stripe.Product | Stripe.DeletedProduct;
    prices.push({
      price: price.id,
      product: "name" in product ? product.name : product.id,
      amount: `$${((price.unit_amount ?? 0) / 100).toFixed(2)}`,
      interval: price.recurring?.interval ?? "one_time",
      active: price.active ? "yes" : "",
      lookup_key: price.lookup_key ?? "",
    });
  }
  table(prices);
}

async function main() {
  console.log("Pricing v2 account report (read-only)");
  await stripeSection();
  await databaseSections();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
