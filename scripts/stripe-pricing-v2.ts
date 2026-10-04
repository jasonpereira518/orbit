/**
 * Pricing v2: create (or confirm) every Stripe object the new plans need, idempotently.
 *
 *   npx tsx scripts/stripe-pricing-v2.ts --mode test                 # dry run: prints the plan
 *   npx tsx scripts/stripe-pricing-v2.ts --mode test --apply         # writes to the sandbox
 *   npx tsx scripts/stripe-pricing-v2.ts --mode live                 # dry run against live
 *   npx tsx scripts/stripe-pricing-v2.ts --mode live --apply --confirm-live
 *
 * Reads STRIPE_SECRET_KEY. `--mode` must match the key (`sk_test_` for test, `sk_live_` or
 * `rk_live_` for live) or the script refuses before making a single call. Nothing is written
 * without `--apply`, and nothing live without `--confirm-live` as well.
 *
 * What it ensures:
 *  - Products: Orbit Pro (reused if it exists), Orbit Max, Orbit credit pack.
 *  - Prices, found by lookup key so the app never needs a new env var:
 *      orbit_pro_monthly_v2   $8.99 / month
 *      orbit_max_monthly_v2   $19.99 / month
 *      orbit_pro_annual_v2    $89.99 / year  (two months free)
 *      orbit_max_annual_v2    $199.99 / year (two months free)
 *      orbit_credit_pack_250  $5.00 once (250 credits)
 *  - Founding coupons with fixed ids, `repeating`:
 *      orbit-founding-pro-{3,2,1}m   $2.00 off Pro for 3 / 2 / 1 months
 *      orbit-founding-max-{3,2,1}m   $4.00 off Max for 3 / 2 / 1 months
 *    Three lengths per tier, not one: a repeating coupon's clock restarts whenever it is
 *    applied, so when a founding subscriber switches tier inside their window the app swaps
 *    to the coupon for the whole months that remain (`src/lib/founding.ts`).
 *  - A customer-portal configuration (metadata orbit_config=pricing_v2): Pro ↔ Max and
 *    monthly ↔ annual switching,
 *    upgrades invoiced immediately and prorated, downgrades scheduled at period end, cancel at
 *    period end, card and invoice history. Lifetime is never in it.
 *  - Archives (never deletes) the old prices: Pro $5/month, Pro $50/year, Lifetime $25 and $75.
 *    Existing subscribers keep whatever price they are on; archiving only stops new sales.
 *
 * Coupons and prices are immutable in Stripe. If an object with our id or lookup key exists
 * but disagrees with what is below, the script stops and says so rather than "fixing" it.
 *
 * The public business name ("stripe-almond-grass" in the sandbox) is an account setting the
 * API cannot change: Dashboard → Settings → Business → Public details, in each mode.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import Stripe from "stripe";

type Mode = "test" | "live";

const args = process.argv.slice(2);
const modeArg = args[args.indexOf("--mode") + 1];
const APPLY = args.includes("--apply");
const CONFIRM_LIVE = args.includes("--confirm-live");
const appUrlIdx = args.indexOf("--app-url");
const APP_URL = (appUrlIdx >= 0 ? args[appUrlIdx + 1] : "https://myorbitnetwork.com").replace(/\/$/, "");

const PRICE_LOOKUP_KEYS = {
  pro: "orbit_pro_monthly_v2",
  max: "orbit_max_monthly_v2",
  proAnnual: "orbit_pro_annual_v2",
  maxAnnual: "orbit_max_annual_v2",
  pack: "orbit_credit_pack_250",
} as const;

/**
 * Descriptions show on Stripe's checkout page and invoices, so they follow the same rule as
 * the pricing page: shipped features only (no Outreach, Events or extension).
 */
const PRODUCTS = {
  pro: {
    name: "Orbit Pro",
    description: "Unlimited contacts, AI included (200 credits a month), recruiter tracking, and meeting transcription.",
    metadata: { orbit_product: "pro" },
  },
  max: {
    name: "Orbit Max",
    description: "Everything in Orbit Pro with 500 AI credits a month, more transcription and enrichment, and the REST API.",
    metadata: { orbit_product: "max" },
  },
  pack: {
    name: "Orbit credit pack",
    description: "250 AI credits for Orbit Pro or Orbit Max. Credits roll over while you're subscribed.",
    metadata: { orbit_product: "credit_pack", orbit_credits: "250" },
  },
} as const;

/** Each price, and the product it sells. Annual is two months free. */
const PRICES = {
  pro: { product: "pro", unit_amount: 899, recurring: { interval: "month" as const }, nickname: "Orbit Pro monthly (v2)" },
  max: { product: "max", unit_amount: 1999, recurring: { interval: "month" as const }, nickname: "Orbit Max monthly (v2)" },
  proAnnual: { product: "pro", unit_amount: 8999, recurring: { interval: "year" as const }, nickname: "Orbit Pro annual (v2)" },
  maxAnnual: { product: "max", unit_amount: 19999, recurring: { interval: "year" as const }, nickname: "Orbit Max annual (v2)" },
  pack: { product: "pack", unit_amount: 500, recurring: null, nickname: "Orbit credit pack (250 credits)" },
} as const;

const COUPONS = (["pro", "max"] as const).flatMap((tier) =>
  [3, 2, 1].map((months) => ({
    id: `orbit-founding-${tier}-${months}m`,
    tier,
    months,
    amount_off: tier === "pro" ? 200 : 400,
    name: `Founding price (${tier === "pro" ? "Orbit Pro" : "Orbit Max"})`,
  }))
);

/** Old prices to archive: product name + amount + interval ("one_time" for Lifetime). */
const LEGACY = [
  { product: "Orbit Pro", amount: 500, interval: "month" },
  { product: "Orbit Pro", amount: 5000, interval: "year" },
  { product: "Orbit Lifetime", amount: 2500, interval: "one_time" },
  { product: "Orbit Lifetime", amount: 7500, interval: "one_time" },
] as const;

const PORTAL_METADATA_KEY = "orbit_config";
const PORTAL_METADATA_VALUE = "pricing_v2";

type Step = { describe: string; run: () => Promise<unknown> };
const steps: Step[] = [];
const notes: string[] = [];

function fail(message: string): never {
  console.error(`\nREFUSED: ${message}`);
  process.exit(1);
}

function keyMode(key: string): Mode | null {
  if (/^sk_test_|^rk_test_/.test(key)) return "test";
  if (/^sk_live_|^rk_live_/.test(key)) return "live";
  return null;
}

async function findProduct(stripe: Stripe, which: keyof typeof PRODUCTS) {
  const wanted = PRODUCTS[which];
  let byName: Stripe.Product | null = null;
  for await (const product of stripe.products.list({ limit: 100 })) {
    if (product.metadata?.orbit_product === wanted.metadata.orbit_product) return product;
    if (product.name === wanted.name && product.active && !byName) byName = product;
  }
  return byName;
}

async function findPriceByLookupKey(stripe: Stripe, lookupKey: string) {
  const { data } = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  return data[0] ?? null;
}

async function main() {
  if (modeArg !== "test" && modeArg !== "live") fail("pass --mode test or --mode live");
  const mode: Mode = modeArg;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) fail("STRIPE_SECRET_KEY is not set");
  if (keyMode(key) !== mode) fail(`--mode ${mode} but STRIPE_SECRET_KEY is a ${keyMode(key) ?? "unrecognised"} key`);
  if (mode === "live" && APPLY && !CONFIRM_LIVE) fail("live writes need --confirm-live as well as --apply");

  const stripe = new Stripe(key);
  const account = await stripe.accounts.retrieveCurrent();
  console.log(
    `Stripe ${mode.toUpperCase()} · ${account.settings?.dashboard?.display_name ?? account.id} · ${APPLY ? "APPLY" : "dry run"}`
  );
  const publicName = account.business_profile?.name ?? account.settings?.dashboard?.display_name ?? "";
  if (!publicName || /almond-grass/.test(publicName)) {
    notes.push(
      `Public business name is "${publicName || "(unset)"}". Set it to "Orbit" in Dashboard → Settings → Business → Public details (${mode} mode); the API cannot.`
    );
  }

  // --- Products and prices ---------------------------------------------------------------
  const productIds: Partial<Record<keyof typeof PRODUCTS, string>> = {};
  const priceIds: Partial<Record<keyof typeof PRICES, string>> = {};
  // Product steps are planned once per product, however many of its prices need creating.
  const productPlanned = new Set<keyof typeof PRODUCTS>();
  for (const which of ["pro", "max", "proAnnual", "maxAnnual", "pack"] as const) {
    const lookupKey = PRICE_LOOKUP_KEYS[which];
    const spec = PRICES[which];
    const productKey = spec.product;
    const existingPrice = await findPriceByLookupKey(stripe, lookupKey);
    if (existingPrice) {
      const interval = existingPrice.recurring?.interval ?? null;
      if (existingPrice.unit_amount !== spec.unit_amount || interval !== (spec.recurring?.interval ?? null)) {
        fail(`price ${lookupKey} exists (${existingPrice.id}) but is ${existingPrice.unit_amount}/${interval}; expected ${spec.unit_amount}/${spec.recurring?.interval ?? "one_time"}`);
      }
      if (!existingPrice.active) {
        steps.push({
          describe: `reactivate price ${lookupKey} (${existingPrice.id})`,
          run: () => stripe.prices.update(existingPrice.id, { active: true }),
        });
      }
      priceIds[which] = existingPrice.id;
      const productId =
        typeof existingPrice.product === "string" ? existingPrice.product : existingPrice.product.id;
      productIds[productKey] = productId;
      console.log(`  ok  price ${lookupKey} = ${existingPrice.id}`);
      if (productPlanned.has(productKey)) continue;
      productPlanned.add(productKey);
      const product = await stripe.products.retrieve(productId);
      const wantedDescription = PRODUCTS[productKey].description;
      if (product.description !== wantedDescription) {
        steps.push({
          describe: `set the ${PRODUCTS[productKey].name} description (customer-facing: shipped features only)`,
          run: () => stripe.products.update(productId, { description: wantedDescription }),
        });
      }
      continue;
    }

    const product = productIds[productKey] || productPlanned.has(productKey) ? null : await findProduct(stripe, productKey);
    const productSpec = PRODUCTS[productKey];
    let productId = productIds[productKey] ?? product?.id;
    if (productPlanned.has(productKey)) {
      // Already found or planned by this product's other price.
    } else if (product) {
      productPlanned.add(productKey);
      console.log(`  ok  product ${productSpec.name} = ${product.id}`);
      if (
        product.metadata?.orbit_product !== productSpec.metadata.orbit_product ||
        product.description !== productSpec.description
      ) {
        steps.push({
          describe: `tag product ${product.id} with orbit_product=${productSpec.metadata.orbit_product} and its description`,
          run: () =>
            stripe.products.update(product.id, { metadata: productSpec.metadata, description: productSpec.description }),
        });
      }
    } else {
      productPlanned.add(productKey);
      steps.push({
        describe: `create product "${productSpec.name}"`,
        run: async () => {
          const created = await stripe.products.create({ ...productSpec });
          productId = created.id;
          productIds[productKey] = created.id;
        },
      });
    }
    if (productId) productIds[productKey] = productId;
    steps.push({
      describe: `create price ${lookupKey}: $${(spec.unit_amount / 100).toFixed(2)}${spec.recurring ? `/${spec.recurring.interval}` : " once"}`,
      run: async () => {
        const created = await stripe.prices.create({
          product: productIds[productKey] ?? productId!,
          currency: "usd",
          unit_amount: spec.unit_amount,
          nickname: spec.nickname,
          lookup_key: lookupKey,
          ...(spec.recurring ? { recurring: spec.recurring } : {}),
          metadata: { orbit_pricing: "v2" },
        });
        priceIds[which] = created.id;
      },
    });
  }

  // --- Founding coupons -------------------------------------------------------------------
  for (const coupon of COUPONS) {
    let existing: Stripe.Coupon | null = null;
    try {
      existing = await stripe.coupons.retrieve(coupon.id);
    } catch (err) {
      if ((err as { code?: string }).code !== "resource_missing") throw err;
    }
    if (existing) {
      const matches =
        existing.amount_off === coupon.amount_off &&
        existing.currency === "usd" &&
        existing.duration === "repeating" &&
        existing.duration_in_months === coupon.months &&
        existing.valid;
      if (!matches) fail(`coupon ${coupon.id} exists but does not match (${JSON.stringify({ amount_off: existing.amount_off, duration: existing.duration, months: existing.duration_in_months, valid: existing.valid })})`);
      console.log(`  ok  coupon ${coupon.id}`);
      continue;
    }
    steps.push({
      describe: `create coupon ${coupon.id}: $${(coupon.amount_off / 100).toFixed(2)} off for ${coupon.months} month(s)`,
      run: () =>
        stripe.coupons.create({
          id: coupon.id,
          name: coupon.name,
          amount_off: coupon.amount_off,
          currency: "usd",
          duration: "repeating",
          duration_in_months: coupon.months,
          metadata: { orbit_founding_tier: coupon.tier, orbit_founding_months: String(coupon.months) },
        }),
    });
  }

  // --- Customer portal ---------------------------------------------------------------------
  let portal: Stripe.BillingPortal.Configuration | null = null;
  for await (const configuration of stripe.billingPortal.configurations.list({ limit: 100 })) {
    if (configuration.metadata?.[PORTAL_METADATA_KEY] === PORTAL_METADATA_VALUE) {
      portal = configuration;
      break;
    }
  }
  const portalParams = (): Stripe.BillingPortal.ConfigurationCreateParams => ({
    name: "Orbit (pricing v2)",
    metadata: { [PORTAL_METADATA_KEY]: PORTAL_METADATA_VALUE },
    business_profile: {
      headline: "Orbit — manage your plan",
      privacy_policy_url: `${APP_URL}/privacy`,
      terms_of_service_url: `${APP_URL}/terms`,
    },
    default_return_url: `${APP_URL}/settings#settings-plan`,
    features: {
      customer_update: { enabled: true, allowed_updates: ["email", "address"] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: "at_period_end",
        cancellation_reason: {
          enabled: true,
          options: ["too_expensive", "missing_features", "switched_service", "unused", "other"],
        },
      },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        products: [
          { product: productIds.pro!, prices: [priceIds.pro!, priceIds.proAnnual!] },
          { product: productIds.max!, prices: [priceIds.max!, priceIds.maxAnnual!] },
        ],
        // Anything that costs more (Pro → Max, monthly → annual): now, prorated, invoiced now.
        // Anything that costs less (Max → Pro, annual → monthly): at the period end.
        proration_behavior: "always_invoice",
        schedule_at_period_end: { conditions: [{ type: "decreasing_item_amount" }] },
      },
    },
  });
  steps.push({
    describe: portal
      ? `update portal configuration ${portal.id} (Pro ↔ Max, monthly ↔ annual, downgrades at period end)`
      : "create portal configuration (Pro ↔ Max, monthly ↔ annual, downgrades at period end)",
    run: () =>
      portal
        ? stripe.billingPortal.configurations.update(portal.id, portalParams())
        : stripe.billingPortal.configurations.create(portalParams()),
  });

  // --- Archive legacy prices -------------------------------------------------------------
  const v2Keys = new Set<string>(Object.values(PRICE_LOOKUP_KEYS));
  for await (const price of stripe.prices.list({ active: true, limit: 100, expand: ["data.product"] })) {
    if (price.lookup_key && v2Keys.has(price.lookup_key)) continue;
    const product = price.product as Stripe.Product | Stripe.DeletedProduct;
    const productName = "name" in product ? product.name : "";
    const interval = price.recurring?.interval ?? "one_time";
    const legacy = LEGACY.find(
      (l) => l.product === productName && l.amount === price.unit_amount && l.interval === interval
    );
    if (!legacy) continue;
    steps.push({
      describe: `archive old price ${price.id} (${productName} $${((price.unit_amount ?? 0) / 100).toFixed(2)} ${interval})`,
      run: () => stripe.prices.update(price.id, { active: false }),
    });
  }

  // --- Plan / apply ------------------------------------------------------------------------
  console.log(`\n${steps.length} change(s):`);
  for (const step of steps) console.log(`  - ${step.describe}`);
  if (APPLY) {
    for (const step of steps) {
      await step.run();
      console.log(`  done ${step.describe}`);
    }
  }
  if (notes.length) {
    console.log("\nManual steps:");
    for (const note of notes) console.log(`  * ${note}`);
  }
  if (!APPLY && steps.length) console.log("\nDry run. Re-run with --apply to make these changes.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
