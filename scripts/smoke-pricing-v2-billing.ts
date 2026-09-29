/**
 * Pricing v2 billing, end to end on PGlite with no Stripe:
 *
 *  - Pro and Max checkouts mirror the right tier and value (a founding discount included).
 *  - The tier comes from the PRICE, so a portal switch is honoured.
 *  - The founding discount stops counting at the end of its window.
 *  - A $5 pack grants 250 credits exactly once — across a retried webhook, both fulfil event
 *    types, and verify-on-return — and books one-time cash, never MRR.
 *  - A full refund or a lost dispute of a pack takes back only its UNUSED credits.
 *  - The founding coupon follows a tier switch for the months left in the window.
 *
 * Run: npx tsx scripts/smoke-pricing-v2-billing.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import type Stripe from "stripe";

const USER = "smoke-pv2-billing";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const DAY = 86_400;

run(async () => {
  const { and, eq } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const { billingEvents, creditGrants, userSettings } = await import("../src/db/schema");
  const { ensureUserSettings } = await import("../src/lib/user-settings");
  const billing = await import("../src/lib/billing-stripe");
  const { applyStripeDecision } = await import("../src/lib/stripe-fulfilment");
  const { resolveChargePurpose } = await import("../src/lib/stripe-charge-purpose");
  const founding = await import("../src/lib/founding");
  const { MICROS_PER_CREDIT } = await import("../src/lib/credits/grants");
  const { getEntitlements } = await import("../src/lib/entitlements");

  const db = await getDb();
  await db.delete(creditGrants).where(eq(creditGrants.userId, USER));
  await db.delete(billingEvents).where(eq(billingEvents.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
  await db.update(userSettings).set({ foundingEligible: true }).where(eq(userSettings.userId, USER));

  const now = new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const ctx = (over: Partial<import("../src/lib/billing-stripe").DecideContext> = {}) => ({
    userId: USER,
    beforeCents: 0,
    hadPriorRevenue: false,
    now,
    ...over,
  });
  const event = (type: string, object: unknown, id = `evt_${Math.random().toString(36).slice(2)}`, created = nowS) =>
    ({ id, type, created, data: { object } }) as unknown as Stripe.Event;

  console.log("Founding checkout for Pro");
  {
    const session = {
      id: "cs_pv2_pro",
      client_reference_id: USER,
      payment_status: "paid",
      amount_total: 699,
      currency: "usd",
      customer: "cus_pv2",
      subscription: "sub_pv2",
      metadata: { orbit_plan: "orbit", orbit_founding_off: "200", orbit_founding_tier: "orbit" },
    };
    const d = billing.decideStripeEvent(event("checkout.session.completed", session), ctx());
    const m = d.mirror;
    check("mirrors Pro at the founding price",
      m?.type === "subscription" && m.plan === "orbit" && m.monthlyCents === 699 && m.interval === "month", m);
    check("records the founding redemption on the subscription",
      m?.type === "subscription" && m.founding?.subscriptionId === "sub_pv2", m);
    check("books a new-MRR row of $6.99 keyed on the session",
      d.bookings.length === 1 && d.bookings[0].eventId === "csm:cs_pv2_pro" && d.bookings[0].mrrDeltaCents === 699, d.bookings);
    await applyStripeDecision(d);
    const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
    check("the account is Pro, founding redeemed", row?.subscriptionPlan === "orbit" && row.foundingRedeemedAt instanceof Date
      && row.foundingSubscriptionId === "sub_pv2", row && { plan: row.subscriptionPlan, redeemed: row.foundingRedeemedAt });
    check("…and a founding price never applies to a second subscription",
      !founding.foundingAppliesToNewSubscription(row));
  }

  console.log("\nThe subscription events value the founding window and read the tier off the price");
  const start = nowS - 10 * DAY;
  const until = billing.addMonthsSeconds(start, 3);
  const sub = (lookupKey: string, amount: number, metadata: Record<string, string>) => ({
    id: "sub_pv2",
    object: "subscription",
    status: "active",
    start_date: start,
    customer: "cus_pv2",
    metadata: { orbit_plan: "orbit", orbit_user_id: USER, ...metadata },
    items: { data: [{ id: "si_pv2", quantity: 1, current_period_start: start, current_period_end: start + 30 * DAY,
      price: { id: `price_${lookupKey}`, lookup_key: lookupKey, unit_amount: amount, recurring: { interval: "month", interval_count: 1 } } }] },
  });
  {
    const created = billing.decideStripeEvent(
      event("customer.subscription.created", sub("orbit_pro_monthly_v2", 899, { orbit_founding_off: "200", orbit_founding_tier: "orbit" })),
      ctx({ beforeCents: 699 })
    );
    check("inside the window Pro is worth $6.99 (no spurious movement)",
      created.mirror?.type === "subscription" && created.mirror.monthlyCents === 699 && created.bookings.length === 0, created);
    check("…and carries the window end and the billing period start",
      created.mirror?.type === "subscription" && created.mirror.founding?.windowEndsAt === until && created.mirror.periodStart === start,
      created.mirror);
    await applyStripeDecision(created);

    // A portal switch to Max: the price changes, the checkout metadata does not.
    const switched = billing.decideStripeEvent(
      event("customer.subscription.updated", sub("orbit_max_monthly_v2", 1999, { orbit_founding_off: "200", orbit_founding_tier: "orbit" })),
      ctx({ beforeCents: 699 })
    );
    check("a portal switch to Max mirrors Max, from the price's lookup key",
      switched.mirror?.type === "subscription" && switched.mirror.plan === "max", switched.mirror);

    const afterWindow = billing.decideStripeEvent(
      event("customer.subscription.updated", sub("orbit_pro_monthly_v2", 899, { orbit_founding_off: "200", orbit_founding_until: String(until) }), undefined, until + DAY),
      ctx({ beforeCents: 699 })
    );
    check("after the window the discount stops counting: +$2.00 expansion",
      afterWindow.mirror?.type === "subscription" && afterWindow.mirror.monthlyCents === 899 &&
        afterWindow.bookings[0]?.kind === "expansion" && afterWindow.bookings[0]?.mrrDeltaCents === 200, afterWindow);
  }

  console.log("\nThe founding coupon follows a tier switch");
  {
    const periodEnd = billing.addMonthsSeconds(start, 1);
    const withPeriod = (lookupKey: string, amount: number, metadata: Record<string, string>) => {
      const s = sub(lookupKey, amount, metadata);
      s.items.data[0].current_period_end = periodEnd;
      return s as unknown as Stripe.Subscription;
    };
    const inStep = founding.planFoundingReconcile(withPeriod("orbit_pro_monthly_v2", 899, { orbit_founding_off: "200", orbit_founding_tier: "orbit" }), nowS);
    check("a founding subscription in step only gets its window stamped",
      inStep.result.action === "stamped" &&
        (inStep.update?.metadata as Record<string, string> | undefined)?.orbit_founding_until === String(until), inStep);
    const toMax = founding.planFoundingReconcile(
      withPeriod("orbit_max_monthly_v2", 1999, { orbit_founding_off: "200", orbit_founding_tier: "orbit", orbit_founding_until: String(until) }), nowS);
    check("Pro → Max in month one swaps to the Max coupon for the 2 invoices left",
      toMax.result.action === "swapped" && toMax.result.coupon === "orbit-founding-max-2m" &&
        (toMax.update?.metadata as Record<string, string>).orbit_founding_off === "400" &&
        toMax.update?.proration_behavior === "none", toMax);
    const late = founding.planFoundingReconcile(
      withPeriod("orbit_max_monthly_v2", 1999, { orbit_founding_off: "200", orbit_founding_tier: "orbit", orbit_founding_until: String(until) }), until + DAY);
    check("after the window a switch carries no discount", late.result.action === "swapped" && late.result.coupon === null
      && Array.isArray(late.update?.discounts) && late.update.discounts.length === 0, late);
    const plain = founding.planFoundingReconcile(withPeriod("orbit_max_monthly_v2", 1999, {}), nowS);
    check("a subscription without founding pricing is left alone", plain.result.action === "none" && plain.update === null);
    check("remaining invoices never exceed the 3-month window",
      founding.remainingFoundingInvoices(start, billing.addMonthsSeconds(start, 12)) === 3 &&
        founding.remainingFoundingInvoices(until, until) === 0);
  }

  console.log("\nA credit pack");
  const packSession = {
    id: "cs_pv2_pack",
    client_reference_id: USER,
    payment_status: "paid",
    amount_total: 500,
    currency: "usd",
    customer: "cus_pv2",
    payment_intent: "pi_pv2_pack",
    metadata: { orbit_plan: "credit_pack", orbit_credits: "250" },
  };
  {
    const completed = billing.decideStripeEvent(event("checkout.session.completed", packSession, "evt_pack_1"), ctx());
    check("books one-time cash keyed on the session, zero MRR",
      completed.bookings.length === 1 && completed.bookings[0].eventId === "cs:cs_pv2_pack" &&
        completed.bookings[0].kind === "credit_pack" && completed.bookings[0].amountCents === 500 &&
        (completed.bookings[0].mrrDeltaCents ?? 0) === 0, completed.bookings);
    await applyStripeDecision(completed);
    // The same session again: a retry, the async-success event, and verify-on-return.
    await applyStripeDecision(billing.decideStripeEvent(event("checkout.session.completed", packSession, "evt_pack_1"), ctx()));
    await applyStripeDecision(billing.decideStripeEvent(event("checkout.session.async_payment_succeeded", packSession, "evt_pack_2"), ctx()));
    await applyStripeDecision(billing.decideStripeEvent(event("checkout.session.completed", packSession, "confirm_cs_pv2_pack"), ctx()));
    const grants = await db.select().from(creditGrants).where(and(eq(creditGrants.userId, USER), eq(creditGrants.kind, "pack")));
    check("grants 250 credits exactly once", grants.length === 1 && grants[0].microsGranted === 250 * MICROS_PER_CREDIT
      && grants[0].stripeRef === "pi_pv2_pack", grants);
    const cash = await db.select().from(billingEvents).where(and(eq(billingEvents.userId, USER), eq(billingEvents.kind, "credit_pack")));
    check("and books its $5 once", cash.length === 1 && cash[0].amountCents === 500, cash.map((c) => c.eventId));

    check("the ledger says what the charge paid for",
      (await resolveChargePurpose("pi_pv2_pack", {
        lifetimeOnLedger: async () => false,
        packOnLedger: async () => true,
        checkoutSessionPlan: async () => null,
        hasInvoicePayment: async () => false,
      })) === "credit_pack");
    check("…or, before the ledger has it, the session metadata",
      (await resolveChargePurpose("pi_x", {
        lifetimeOnLedger: async () => false,
        checkoutSessionPlan: async () => "credit_pack",
        hasInvoicePayment: async () => false,
      })) === "credit_pack");

    // 150 of the 250 credits spent, then a full refund.
    await db.update(creditGrants).set({ microsRemaining: 100 * MICROS_PER_CREDIT }).where(eq(creditGrants.id, grants[0].id));
    const charge = {
      id: "ch_pv2_pack",
      object: "charge",
      customer: "cus_pv2",
      payment_intent: "pi_pv2_pack",
      refunded: true,
      amount_captured: 500,
      amount_refunded: 500,
      metadata: { orbit_user_id: USER },
      refunds: { data: [{ id: "re_pv2_pack", amount: 500, created: nowS }] },
    };
    const refunded = billing.decideStripeEvent(event("charge.refunded", charge), ctx({ chargePurpose: "credit_pack" }));
    check("a full refund revokes the pack and books the refund, with no MRR row",
      refunded.mirror?.type === "credit_pack_revoked" && refunded.bookings.length === 1 &&
        refunded.bookings[0].eventId === "re:re_pv2_pack", refunded);
    await applyStripeDecision(refunded);
    await applyStripeDecision(refunded);
    const [after] = await db.select().from(creditGrants).where(eq(creditGrants.id, grants[0].id));
    check("only the unused 100 credits are taken back, once",
      after.status === "revoked" && after.microsRemaining === 0 && after.microsRevoked === 100 * MICROS_PER_CREDIT, after);
  }

  console.log("\nA lost dispute on a pack");
  {
    const session2 = { ...packSession, id: "cs_pv2_pack2", payment_intent: "pi_pv2_pack2" };
    await applyStripeDecision(billing.decideStripeEvent(event("checkout.session.completed", session2), ctx()));
    const dispute = {
      id: "dp_pv2",
      object: "dispute",
      status: "lost",
      amount: 500,
      charge: "ch_pv2_pack2",
      payment_intent: "pi_pv2_pack2",
      metadata: { orbit_user_id: USER },
    };
    const lost = billing.decideStripeEvent(event("charge.dispute.closed", dispute), ctx({ chargePurpose: "credit_pack" }));
    await applyStripeDecision(lost);
    const [grant] = await db.select().from(creditGrants).where(eq(creditGrants.stripeRef, "pi_pv2_pack2"));
    check("the whole unused pack is taken back", grant?.status === "revoked" && grant.microsRevoked === 250 * MICROS_PER_CREDIT, grant);
    check("and the lost money is booked as a refund", lost.bookings.some((b) => b.eventId === "dp:dp_pv2" && b.amountCents === 500));
  }

  console.log("\nA Max checkout");
  {
    const session = {
      id: "cs_pv2_max",
      client_reference_id: USER,
      payment_status: "paid",
      amount_total: 1999,
      customer: "cus_pv2",
      subscription: "sub_pv2_max",
      metadata: { orbit_plan: "max" },
    };
    const d = billing.decideStripeEvent(event("checkout.session.completed", session), ctx());
    check("mirrors Max at list price with no founding claim",
      d.mirror?.type === "subscription" && d.mirror.plan === "max" && d.mirror.monthlyCents === 1999 && !d.mirror.founding, d.mirror);
    await db.update(userSettings).set({ subscriptionPlan: null, subscriptionStatus: null }).where(eq(userSettings.userId, USER));
    await applyStripeDecision(d);
    const ent = await getEntitlements(USER);
    check("the account resolves to Max, with the REST API", ent.plan === "max" && ent.canUseApi, ent.plan);
  }

  console.log("\nWhen the founding discount ends");
  {
    const terms = { offCents: 200, until: 2_000_000_000 };
    const early = 1_000_000_000;
    check("a subscription still carrying its coupon is valued with the discount",
      billing.foundingOffNow(terms, { discounts: ["di_1"] }, early) === 200);
    check("once Stripe removes the coupon it is full price, whatever the event's clock says",
      billing.foundingOffNow(terms, { discounts: [] }, early) === 0);
    check("a payload without the field falls back to the window",
      billing.foundingOffNow(terms, {}, early) === 200 && billing.foundingOffNow(terms, {}, terms.until) === 0);
    check("no founding terms, no discount", billing.foundingOffNow(null, { discounts: ["di_1"] }, early) === 0);
  }

  await db.delete(creditGrants).where(eq(creditGrants.userId, USER));
  await db.delete(billingEvents).where(eq(billingEvents.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures > 0) throw new Error(`${failures} pricing v2 billing check(s) failed`);
  console.log("\nAll pricing v2 billing checks passed.");
});
