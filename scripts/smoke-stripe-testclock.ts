/**
 * Founding pricing against the real Stripe SANDBOX, on test clocks (pricing v2). Manual tier:
 * it talks to Stripe and takes several minutes while the clocks advance.
 *
 *  1. Founding Pro: $6.99 for three invoices, then $8.99 — and the ledger books the $2 as an
 *     expansion when the window closes, so live MRR and the ledger still agree.
 *  2. Founding Pro switched to Max inside the window: the discount follows to Max for the
 *     invoices the window still covers ($15.99), then $19.99; never past the window.
 *
 * Each sandbox event is pulled with `events.list` and run through `processStripeEvent` — the
 * webhook route's own path — at the clock's frozen time, into this run's PGlite. No webhook
 * forwarding is involved; stop any `stripe listen` aimed at a dev server first, or that server
 * will act on these events too.
 *
 * Refuses anything but a test-mode key. Deletes its test clocks (and with them its customers
 * and subscriptions) when it finishes.
 *
 * Run: npx tsx scripts/smoke-stripe-testclock.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import type Stripe from "stripe";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TYPES = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

run(async () => {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new Error("smoke-stripe-testclock runs against the Stripe sandbox only: STRIPE_SECRET_KEY must be a test-mode key.");
  }

  const { eq, inArray } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const schema = await import("../src/db/schema");
  const { getStripe } = await import("../src/lib/stripe");
  const { resolvePriceIds } = await import("../src/lib/stripe-prices");
  const { foundingCheckoutTerms } = await import("../src/lib/founding");
  const { addMonthsSeconds } = await import("../src/lib/billing-stripe");
  const { PLAN_METADATA_KEY, SUBSCRIPTION_USER_METADATA_KEY } = await import("../src/lib/stripe-config");
  const { processStripeEvent } = await import("../src/lib/stripe-event-processor");

  const stripe = getStripe();
  const prices = await resolvePriceIds(stripe);
  const db = await getDb();
  const runId = Date.now().toString(36);
  const users: string[] = [];
  const clocks: string[] = [];

  /** One customer on its own test clock, with a founding Pro subscription. */
  async function start(label: string) {
    const userId = `smoke-tc-${label}-${runId}`;
    users.push(userId);
    await db.insert(schema.userSettings).values({ userId, foundingEligible: true });
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: Math.floor(Date.now() / 1000),
      name: `orbit smoke ${label}`,
    });
    clocks.push(clock.id);
    const customer = await stripe.customers.create({
      test_clock: clock.id,
      email: `${userId}@example.test`,
      payment_method: "pm_card_visa",
    });
    const [card] = (await stripe.paymentMethods.list({ customer: customer.id, type: "card" })).data;
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: card!.id } });
    await db.update(schema.userSettings).set({ stripeCustomerId: customer.id }).where(eq(schema.userSettings.userId, userId));

    const terms = foundingCheckoutTerms("orbit");
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: prices.orbit }],
      discounts: [{ coupon: terms.coupon }],
      metadata: { [PLAN_METADATA_KEY]: "orbit", ...terms.metadata, [SUBSCRIPTION_USER_METADATA_KEY]: userId },
    });
    const seen = new Set<string>();

    const frozen = async () => (await stripe.testHelpers.testClocks.retrieve(clock.id)).frozen_time;

    /** Deliver every event for this customer not delivered yet, oldest first. */
    async function sync() {
      const now = new Date((await frozen()) * 1000);
      const events = (await stripe.events.list({ types: TYPES, limit: 100 }).autoPagingToArray({ limit: 400 }))
        .filter((e) => (e.data.object as { customer?: string }).customer === customer.id && !seen.has(e.id))
        .reverse();
      for (const event of events) {
        seen.add(event.id);
        await processStripeEvent(event as Stripe.Event, {
          now,
          updateSubscription: (id, params) => stripe.subscriptions.update(id, params),
        });
      }
    }

    /** Move the clock to just past the next renewal and wait for Stripe to finish billing. */
    async function advanceMonth() {
      // A day past the renewal: Stripe finalizes a renewal's draft invoice about an hour after
      // it is created, and the payment and its events follow.
      const target = addMonthsSeconds(await frozen(), 1) + 86_400;
      await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: target });
      for (let i = 0; i < 120; i++) {
        const c = await stripe.testHelpers.testClocks.retrieve(clock.id);
        if (c.status === "ready") break;
        if (c.status === "internal_failure") throw new Error(`test clock ${clock.id} failed`);
        await sleep(3000);
      }
      // Event delivery trails the clock by a moment.
      await sleep(4000);
      await sync();
    }

    async function paidInvoices() {
      const invoices = (await stripe.invoices.list({ customer: customer.id, limit: 20 })).data
        .filter((i) => i.status === "paid")
        .sort((a, b) => a.created - b.created);
      return invoices;
    }

    async function ledger() {
      const rows = await db.select().from(schema.billingEvents).where(eq(schema.billingEvents.userId, userId));
      const [row] = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, userId));
      return { rows, mrr: rows.reduce((sum, r) => sum + r.mrrDeltaCents, 0), row: row! };
    }

    /** Keep delivering until `done` holds (events trail the clock), then report what is there. */
    async function settle(done: () => Promise<boolean>) {
      for (let i = 0; i < 24; i++) {
        await sync();
        if (await done()) return;
        await sleep(5000);
      }
      const invoices = (await stripe.invoices.list({ customer: customer.id, limit: 20 })).data
        .sort((a, b) => a.created - b.created)
        .map((i) => [i.status, i.amount_due, i.amount_paid, i.billing_reason]);
      console.error(`  … ${label} did not settle. Invoices:`, JSON.stringify(invoices), "events seen:", seen.size);
    }

    await sleep(4000);
    await sync();
    return { userId, sub, sync, settle, advanceMonth, paidInvoices, ledger };
  }

  try {
    console.log("Scenarios start on their own clocks");
    const [pro, sw] = await Promise.all([start("pro"), start("switch")]);

    const proStart = await pro.ledger();
    check("founding Pro starts at $6.99, booked as new MRR", proStart.row.subscriptionPlan === "orbit" &&
      proStart.row.subscriptionMonthlyCents === 699 && proStart.mrr === 699, { mrr: proStart.mrr, row: proStart.row.subscriptionMonthlyCents });
    check("…with the founding window stamped on the account", proStart.row.foundingWindowEndsAt instanceof Date);

    console.log("\nFounding Pro through the window, and the switch to Max inside it");
    // Month 1 on both clocks; then the second customer moves to Max, as the portal would.
    await Promise.all([pro.advanceMonth(), sw.advanceMonth()]);
    const live = await getStripe().subscriptions.retrieve(sw.sub.id);
    await stripe.subscriptions.update(sw.sub.id, {
      items: [{ id: live.items.data[0]!.id, price: prices.max }],
      proration_behavior: "always_invoice",
    });
    await sleep(5000);
    await sw.sync();
    const swapped = await stripe.subscriptions.retrieve(sw.sub.id, { expand: ["discounts"] });
    const coupons = (swapped.discounts as Stripe.Discount[]).map((d) => (typeof d.source?.coupon === "string" ? d.source.coupon : d.source?.coupon?.id));
    check("the switch carries the discount to Max for the one invoice the window still covers",
      coupons.length === 1 && coupons[0] === "orbit-founding-max-1m", coupons);

    for (let m = 2; m <= 3; m++) await Promise.all([pro.advanceMonth(), sw.advanceMonth()]);

    await Promise.all([
      pro.settle(async () => (await pro.paidInvoices()).length >= 4 && (await pro.ledger()).row.subscriptionMonthlyCents === 899),
      sw.settle(async () => (await sw.ledger()).row.subscriptionMonthlyCents === 1999),
    ]);
    const proInvoices = (await pro.paidInvoices()).map((i) => i.amount_paid);
    check("Pro invoices: three at $6.99, then $8.99", JSON.stringify(proInvoices) === JSON.stringify([699, 699, 699, 899]), proInvoices);
    const proEnd = await pro.ledger();
    check("…the account now carries $8.99 a month", proEnd.row.subscriptionMonthlyCents === 899, proEnd.row.subscriptionMonthlyCents);
    check("…and the ledger booked the $2 as an expansion, so it sums to the live value",
      proEnd.mrr === 899 && proEnd.rows.some((r) => r.kind === "expansion" && r.mrrDeltaCents === 200),
      proEnd.rows.map((r) => [r.kind, r.mrrDeltaCents]));

    const swInvoices = (await sw.paidInvoices()).map((i) => i.amount_paid);
    const tail = swInvoices.slice(-2);
    check("Max after the switch: $15.99 inside the window, then $19.99", JSON.stringify(tail) === JSON.stringify([1599, 1999]), swInvoices);
    const swEnd = await sw.ledger();
    check("…the account is on Max at $19.99, and the ledger agrees",
      swEnd.row.subscriptionPlan === "max" && swEnd.row.subscriptionMonthlyCents === 1999 && swEnd.mrr === 1999,
      { plan: swEnd.row.subscriptionPlan, cents: swEnd.row.subscriptionMonthlyCents, mrr: swEnd.mrr });
  } finally {
    for (const id of clocks) await stripe.testHelpers.testClocks.del(id).catch(() => undefined);
    if (users.length) {
      await db.delete(schema.billingEvents).where(inArray(schema.billingEvents.userId, users));
      await db.delete(schema.creditGrants).where(inArray(schema.creditGrants.userId, users));
      await db.delete(schema.userSettings).where(inArray(schema.userSettings.userId, users));
    }
  }

  if (failures > 0) throw new Error(`${failures} test-clock check(s) failed`);
  console.log("\nAll test-clock checks passed.");
});
