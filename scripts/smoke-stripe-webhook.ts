/**
 * Drives the real Stripe webhook route with real signatures, using the SDK's
 * `generateTestHeaderString`. No network, no Stripe account, no live keys.
 *
 * Covers the things most likely to break silently: signature verification, attribution
 * via client_reference_id, the metadata guard, unpaid sessions, and idempotency.
 *
 * Run: npx tsx scripts/smoke-stripe-webhook.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

/**
 * FORCE LOCAL PGLITE.
 *
 * `.env.local` sets `DATABASE_URL`, so without this line a script that reads as a local
 * smoke test inserts `billing_events` and `user_settings` rows straight into the shared
 * Neon database — and then deletes rows out of it in `reset()`. Money assertions are
 * exactly the wrong thing to run against production by accident.
 */
delete process.env.DATABASE_URL;

const TEST_SECRET = "whsec_test_smoke_only_not_a_real_secret";
process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
process.env.STRIPE_SECRET_KEY ||= "sk_test_smoke_only_not_a_real_key";

import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings, billingEvents, webhookDeliveries } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import { getEntitlements } from "../src/lib/entitlements";
import {
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
  PRO_METADATA_VALUE,
  SUBSCRIPTION_USER_METADATA_KEY,
} from "../src/lib/stripe";
import { resolvePlan } from "../src/lib/entitlements";
import { POST } from "../src/app/api/webhooks/stripe/route";
import { mrrMovement, mrrReconciliation } from "../src/lib/billing-events";

const USER = "smoke-stripe-user";
// Separate user for the Pro path: `getEntitlements` is a React cache() memo, so plan
// checks after a state change use `resolvePlan` on a fresh row — but the one full-path
// entitlements check needs a user id the memo has never seen.
const PRO_USER = "smoke-stripe-pro-user";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

function check(label: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${label} FAILED${detail ? `: ${detail}` : ""}`);
  console.log("  ok  " + label);
}

function sessionEvent(over: Record<string, unknown> = {}) {
  return {
    id: "evt_smoke_1",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_smoke_1",
        object: "checkout.session",
        client_reference_id: USER,
        payment_status: "paid",
        customer: "cus_smoke_1",
        metadata: { [LIFETIME_METADATA_KEY]: LIFETIME_METADATA_VALUE },
        ...over,
      },
    },
  };
}

/** Builds a request the route handler can consume, signed the way Stripe signs. */
function signedRequest(event: unknown, secret = TEST_SECRET) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

// The route is typed for NextRequest but only uses headers/text, which Request provides.
const post = (req: Request) =>
  POST(req as unknown as Parameters<typeof POST>[0]);

/** A user whose whole lifecycle is cash, kept off the MRR users' ledgers. */
const CASH_USER = "smoke-stripe-cash-user";

function invoiceEvent(
  type: "invoice.paid" | "invoice.payment_failed",
  over: Record<string, unknown> = {},
  eventId = "evt_smoke_invoice_1"
) {
  return {
    id: eventId,
    object: "event",
    type,
    created: 1_700_000_000,
    data: {
      object: {
        id: "in_smoke_1",
        object: "invoice",
        customer: "cus_smoke_cash",
        subscription: "sub_smoke_cash",
        currency: "usd",
        amount_paid: 500,
        amount_due: 500,
        attempt_count: 1,
        billing_reason: "subscription_cycle",
        status_transitions: { paid_at: 1_700_000_000 },
        ...over,
      },
    },
  };
}

function chargeRefundedEvent(
  refunds: Array<{ id: string; amount: number }>,
  amountRefunded: number,
  eventId: string
) {
  return {
    id: eventId,
    object: "event",
    type: "charge.refunded",
    created: 1_700_000_100,
    data: {
      object: {
        id: "ch_smoke_1",
        object: "charge",
        customer: "cus_smoke_cash",
        currency: "usd",
        amount_refunded: amountRefunded,
        refunds: {
          object: "list",
          data: refunds.map((r) => ({
            id: r.id,
            object: "refund",
            amount: r.amount,
            created: 1_700_000_100,
            reason: "requested_by_customer",
          })),
        },
      },
    },
  };
}

function disputeEvent(
  type: "charge.dispute.created" | "charge.dispute.closed",
  over: Record<string, unknown> = {},
  eventId = "evt_smoke_dispute_1"
) {
  return {
    id: eventId,
    object: "event",
    type,
    created: 1_700_000_200,
    data: {
      object: {
        id: "dp_smoke_1",
        object: "dispute",
        charge: "ch_smoke_1",
        customer: "cus_smoke_cash",
        amount: 500,
        reason: "fraudulent",
        status: "warning_needs_response",
        ...over,
      },
    },
  };
}

/** An annual Pro checkout session — $50/yr, which must book as $4.17/mo. */
function annualProSession(eventId = "evt_smoke_annual_1") {
  return {
    id: eventId,
    object: "event",
    type: "checkout.session.completed",
    created: 1_700_000_300,
    data: {
      object: {
        id: "cs_test_smoke_annual",
        object: "checkout.session",
        client_reference_id: ANNUAL_USER,
        payment_status: "paid",
        customer: "cus_smoke_annual",
        mode: "subscription",
        amount_total: 5000,
        metadata: {
          [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE,
          orbit_billing_period: "annual",
        },
      },
    },
  };
}

/** The subscription object Stripe sends next, carrying the real annual price. */
function annualSubEvent(
  type: "customer.subscription.updated" | "customer.subscription.deleted",
  over: Record<string, unknown> = {},
  eventId = "evt_smoke_annual_sub_1"
) {
  return {
    id: eventId,
    object: "event",
    type,
    created: 1_700_000_400,
    data: {
      object: {
        id: "sub_smoke_annual",
        object: "subscription",
        customer: "cus_smoke_annual",
        status: "active",
        metadata: {
          [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE,
          [SUBSCRIPTION_USER_METADATA_KEY]: ANNUAL_USER,
        },
        items: {
          object: "list",
          data: [
            {
              id: "si_smoke_annual",
              quantity: 1,
              current_period_end: 1_800_000_000,
              price: {
                id: "price_annual",
                unit_amount: 5000,
                recurring: { interval: "year", interval_count: 1 },
              },
            },
          ],
        },
        ...over,
      },
    },
  };
}

const ANNUAL_USER = "smoke-stripe-annual-user";

async function ledgerFor(userId: string) {
  const db = await getDb();
  return db.select().from(billingEvents).where(eq(billingEvents.userId, userId));
}

async function lifetimeAt() {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, USER),
  });
  return row?.lifetimePurchasedAt ?? null;
}

async function reset() {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, PRO_USER));
  // A prior run that failed partway through exits before reaching its own cleanup at
  // the bottom, leaving ledger rows behind — clear them too, or the "exactly N
  // movements" assertions below count leftovers from that earlier attempt.
  await db.delete(billingEvents).where(eq(billingEvents.userId, USER));
  await db.delete(billingEvents).where(eq(billingEvents.userId, PRO_USER));
  await db.delete(userSettings).where(eq(userSettings.userId, CASH_USER));
  await db.delete(userSettings).where(eq(userSettings.userId, ANNUAL_USER));
  await db.delete(billingEvents).where(eq(billingEvents.userId, CASH_USER));
  await db.delete(billingEvents).where(eq(billingEvents.userId, ANNUAL_USER));
  await db.delete(webhookDeliveries).where(eq(webhookDeliveries.source, "stripe"));
  await ensureUserSettings(USER);
}

async function main() {
  console.log("Stripe webhook smoke test (pglite)…\n");
  await reset();

  console.log("rejects what it should");
  const noSig = await post(
    new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      body: "{}",
    })
  );
  check("missing signature -> 400", noSig.status === 400, String(noSig.status));

  const badSig = await post(signedRequest(sessionEvent(), "whsec_wrong_secret"));
  check("wrong secret -> 400", badSig.status === 400, String(badSig.status));

  const tampered = new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: {
      "stripe-signature": stripe.webhooks.generateTestHeaderString({
        payload: JSON.stringify(sessionEvent()),
        secret: TEST_SECRET,
      }),
    },
    // Same signature, different body — exactly what a raw-body mistake would let through.
    body: JSON.stringify(sessionEvent({ client_reference_id: "attacker" })),
  });
  const tamperedRes = await post(tampered);
  check("tampered body -> 400", tamperedRes.status === 400, String(tamperedRes.status));
  check("nothing granted by rejected calls", (await lifetimeAt()) === null);

  console.log("\nignores what it should");
  const wrongProduct = await post(
    signedRequest(sessionEvent({ metadata: { [LIFETIME_METADATA_KEY]: "something-else" } }))
  );
  check("other product -> 200 but no grant", wrongProduct.status === 200 && (await lifetimeAt()) === null);

  const unpaid = await post(signedRequest(sessionEvent({ payment_status: "unpaid" })));
  check("unpaid session -> no grant", unpaid.status === 200 && (await lifetimeAt()) === null);

  const noUser = await post(signedRequest(sessionEvent({ client_reference_id: null })));
  check("no client_reference_id -> no grant", noUser.status === 200 && (await lifetimeAt()) === null);

  console.log("\ngrants on a real purchase");
  const ok = await post(signedRequest(sessionEvent()));
  check("valid event -> 200", ok.status === 200, String(ok.status));

  const granted = await lifetimeAt();
  check("lifetime_purchased_at written", granted !== null);

  const ent = await getEntitlements(USER);
  check("entitlements resolve to lifetime", ent.plan === "lifetime", ent.plan);
  check("hosted sending unlocked on lifetime", ent.canUseHostedSending === true);
  check("hosted enrichment still gated on lifetime", ent.canUseHostedEnrichment === false);
  check("contacts uncapped", ent.contactLimit === null);

  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, USER),
  });
  check("stripe customer id stored", row?.stripeCustomerId === "cus_smoke_1", String(row?.stripeCustomerId));

  console.log("\nsurvives Stripe's retries");
  await post(signedRequest(sessionEvent()));
  await post(signedRequest({ ...sessionEvent(), type: "checkout.session.async_payment_succeeded" }));
  const after = await lifetimeAt();
  check(
    "repeat deliveries keep the first timestamp",
    after?.getTime() === granted?.getTime(),
    `${granted?.toISOString()} -> ${after?.toISOString()}`
  );

  console.log("\ngrants a Pro subscription purchase");
  await db.delete(userSettings).where(eq(userSettings.userId, PRO_USER));
  await ensureUserSettings(PRO_USER);

  const proRow = async () =>
    (await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, PRO_USER),
    }))!;

  const proSession = sessionEvent({
    id: "cs_test_smoke_pro",
    client_reference_id: PRO_USER,
    customer: "cus_smoke_pro",
    mode: "subscription",
    metadata: { [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE },
  });
  const proOk = await post(signedRequest(proSession));
  check("pro session -> 200", proOk.status === 200, String(proOk.status));

  let proState = await proRow();
  check("subscription_plan written", proState.subscriptionPlan === "orbit");
  check("subscription_status active", proState.subscriptionStatus === "active");
  check("pro customer id stored", proState.stripeCustomerId === "cus_smoke_pro");
  check("no lifetime cross-grant", proState.lifetimePurchasedAt === null);

  const proEnt = await getEntitlements(PRO_USER);
  check("entitlements resolve to orbit", proEnt.plan === "orbit", proEnt.plan);
  check("hosted sending unlocked on pro", proEnt.canUseHostedSending === true);
  check("hosted enrichment unlocked on pro", proEnt.canUseHostedEnrichment === true);
  check("contacts uncapped on pro", proEnt.contactLimit === null);

  console.log("\ntracks the subscription lifecycle");
  const nowSec = Math.floor(Date.now() / 1000);
  const future = nowSec + 20 * 86400;
  const past = nowSec - 86400;

  // Real Stripe events always carry a unique id — `recordBillingEvent` dedupes on
  // (source, eventId), so reusing one id across distinct lifecycle transitions would
  // silently drop every ledger write after the first.
  let subEventCounter = 0;
  const subEvent = (
    type: string,
    over: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    id: `evt_smoke_sub_${++subEventCounter}`,
    object: "event",
    type,
    data: {
      object: {
        id: "sub_smoke_1",
        object: "subscription",
        status: "active",
        customer: "cus_smoke_pro",
        metadata: {
          [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE,
          [SUBSCRIPTION_USER_METADATA_KEY]: PRO_USER,
        },
        // Recent Stripe API versions carry the paid-through date on the item.
        items: { data: [{ id: "si_smoke_1", current_period_end: future }] },
        ...over,
      },
    },
  });

  await post(signedRequest(subEvent("customer.subscription.updated")));
  proState = await proRow();
  check(
    "renewal writes period end from the item",
    proState.subscriptionPeriodEnd?.getTime() === future * 1000,
    String(proState.subscriptionPeriodEnd)
  );

  await post(
    signedRequest(subEvent("customer.subscription.updated", { status: "canceled" }))
  );
  proState = await proRow();
  check("cancel keeps plan with canceled status", proState.subscriptionStatus === "canceled");
  check(
    "canceled + future period end still resolves orbit",
    resolvePlan(proState).plan === "orbit",
    resolvePlan(proState).plan
  );

  await post(
    signedRequest(
      subEvent("customer.subscription.deleted", {
        status: "canceled",
        items: { data: [{ id: "si_smoke_1", current_period_end: past }] },
      })
    )
  );
  proState = await proRow();
  check(
    "expired cancellation resolves free",
    resolvePlan(proState).plan === "free",
    resolvePlan(proState).plan
  );

  console.log("\nattributes and guards subscription events");
  await post(
    signedRequest(subEvent("customer.subscription.updated", { metadata: {} }))
  );
  proState = await proRow();
  check(
    "metadata-less event attributed via customer id",
    proState.subscriptionStatus === "active" &&
      proState.subscriptionPeriodEnd?.getTime() === future * 1000
  );

  await post(
    signedRequest(
      subEvent("customer.subscription.updated", {
        status: "canceled",
        metadata: { [LIFETIME_METADATA_KEY]: "something-else" },
      })
    )
  );
  proState = await proRow();
  check("other product's subscription ignored", proState.subscriptionStatus === "active");

  await post(
    signedRequest(subEvent("customer.subscription.updated", { status: "unpaid" }))
  );
  proState = await proRow();
  check(
    "unpaid clears the mirror",
    proState.subscriptionPlan === null && proState.subscriptionStatus === null
  );

  console.log("\nbooks MRR movement into billing_events");
  // Across the lifecycle above: checkout (new +500), active→active (no delta),
  // active→canceled-with-future-periodEnd (no delta, matches "not churned yet"
  // semantics), canceled-with-past-periodEnd (churn -500), reattributed reactivation
  // (reactivation +500), wrong-product event (ignored, no row), unpaid (churn -500).
  //
  // That fifth event was always a reactivation — the comment here said so before the
  // ledger could express it. `classifyMovement` hard-coded every 0→positive move to
  // "new", so the kind existed in the union and could never be written. It is asserted
  // as itself now.
  const proLedger = await db
    .select()
    .from(billingEvents)
    .where(eq(billingEvents.userId, PRO_USER));
  check("exactly 4 movements recorded", proLedger.length === 4, String(proLedger.length));
  check(
    "one 'new' entry at +500",
    proLedger.filter((r) => r.kind === "new" && r.mrrDeltaCents === 500).length === 1,
    JSON.stringify(proLedger.map((r) => `${r.kind}${r.mrrDeltaCents}`))
  );
  check(
    "the return is booked as 'reactivation', not a second 'new'",
    proLedger.filter((r) => r.kind === "reactivation" && r.mrrDeltaCents === 500)
      .length === 1
  );
  // The property that makes the reactivation gate safe to get wrong: whichever kind is
  // chosen, the delta is the same, so a misclassification can misfile a row but can never
  // move net MRR.
  check(
    "net recurring movement is unchanged by the split",
    proLedger.reduce((sum, r) => sum + r.mrrDeltaCents, 0) === 0,
    String(proLedger.reduce((sum, r) => sum + r.mrrDeltaCents, 0))
  );
  check(
    "two 'churn' entries at -500",
    proLedger.filter((r) => r.kind === "churn" && r.mrrDeltaCents === -500).length === 2
  );
  check(
    "every row sourced from stripe",
    proLedger.every((r) => r.source === "stripe")
  );

  console.log("\nledger is idempotent on retry");
  const beforeRetryCount = proLedger.length;
  // Redeliver the exact same checkout completion — same event.id, so the ledger's unique
  // (source, event_id) index must drop it rather than double-book the "new" movement.
  await post(signedRequest(proSession));
  const afterRetry = await db
    .select()
    .from(billingEvents)
    .where(eq(billingEvents.userId, PRO_USER));
  check(
    "replaying checkout.session.completed adds no new ledger row",
    afterRetry.length === beforeRetryCount,
    `${beforeRetryCount} -> ${afterRetry.length}`
  );

  /* ------------------------------------------------- cash is not MRR ------------- */
  console.log("\nbooks cash without touching MRR");
  await ensureUserSettings(CASH_USER);
  await db
    .update(userSettings)
    .set({ stripeCustomerId: "cus_smoke_cash" })
    .where(eq(userSettings.userId, CASH_USER));

  await post(signedRequest(invoiceEvent("invoice.paid")));
  let cashLedger = await ledgerFor(CASH_USER);
  check("invoice.paid books exactly one row", cashLedger.length === 1, String(cashLedger.length));
  check("…as kind 'payment'", cashLedger[0]?.kind === "payment", String(cashLedger[0]?.kind));
  check("…with the invoice's cash", cashLedger[0]?.amountCents === 500);
  check("…and zero MRR delta", cashLedger[0]?.mrrDeltaCents === 0);
  check(
    "…keyed on the invoice, not the event",
    cashLedger[0]?.eventId === "in:in_smoke_1",
    String(cashLedger[0]?.eventId)
  );

  // THE DOUBLE-COUNT TEST. `invoice.paid` and `customer.subscription.updated` both fire
  // for a renewal. Cash must go up and recurring MRR must not move at all.
  const beforeRenewal = await mrrMovement(new Date(0), new Date(3_000_000_000_000));
  await post(
    signedRequest(
      invoiceEvent(
        "invoice.paid",
        { id: "in_smoke_2", amount_paid: 500, billing_reason: "subscription_cycle" },
        "evt_smoke_invoice_2"
      )
    )
  );
  const afterRenewal = await mrrMovement(new Date(0), new Date(3_000_000_000_000));
  check(
    "a renewal adds cash",
    afterRenewal.paymentCents === beforeRenewal.paymentCents + 500,
    `${beforeRenewal.paymentCents} -> ${afterRenewal.paymentCents}`
  );
  check(
    "a renewal moves recurring MRR by exactly zero",
    afterRenewal.netCents === beforeRenewal.netCents,
    `${beforeRenewal.netCents} -> ${afterRenewal.netCents}`
  );

  console.log("\ndeduplicates cash by object, not by event id");
  // Same invoice announced by a different event id — which is what `invoice.paid` and
  // `invoice.payment_succeeded` do. (source, event_id) alone would book it twice.
  await post(signedRequest(invoiceEvent("invoice.paid", {}, "evt_smoke_invoice_1_again")));
  cashLedger = await ledgerFor(CASH_USER);
  check(
    "the same invoice under a new event id books nothing",
    cashLedger.filter((r) => r.eventId === "in:in_smoke_1").length === 1,
    String(cashLedger.length)
  );

  console.log("\nhandles partial refunds without cumulating");
  // `charge.refunded` carries a CUMULATIVE amount_refunded. Booking that field turns
  // 500 + 500 into 500 + 1000 = 1500.
  await post(
    signedRequest(chargeRefundedEvent([{ id: "re_1", amount: 500 }], 500, "evt_refund_1"))
  );
  await post(
    signedRequest(
      chargeRefundedEvent(
        [
          { id: "re_1", amount: 500 },
          { id: "re_2", amount: 500 },
        ],
        1000,
        "evt_refund_2"
      )
    )
  );
  cashLedger = await ledgerFor(CASH_USER);
  const refundRows = cashLedger.filter((r) => r.kind === "refund");
  check("two partial refunds book two rows", refundRows.length === 2, String(refundRows.length));
  check(
    "…totalling 1000, not the cumulative 1500",
    refundRows.reduce((sum, r) => sum + r.amountCents, 0) === 1000,
    String(refundRows.reduce((sum, r) => sum + r.amountCents, 0))
  );

  console.log("\ndistinguishes a dispute from a loss");
  await post(signedRequest(disputeEvent("charge.dispute.created")));
  cashLedger = await ledgerFor(CASH_USER);
  const openDispute = cashLedger.filter((r) => r.kind === "payment_failed");
  check("an opened dispute is an incident, not cash out", openDispute.length === 1);
  check("…booked at zero", openDispute[0]?.amountCents === 0);

  await post(
    signedRequest(
      disputeEvent("charge.dispute.closed", { status: "won" }, "evt_smoke_dispute_won")
    )
  );
  const wonCount = (await ledgerFor(CASH_USER)).filter((r) => r.kind === "refund").length;
  check("a won dispute removes no money", wonCount === 2, String(wonCount));

  await post(
    signedRequest(
      disputeEvent("charge.dispute.closed", { status: "lost" }, "evt_smoke_dispute_lost")
    )
  );
  cashLedger = await ledgerFor(CASH_USER);
  check(
    "a lost dispute books the cash out",
    cashLedger.some((r) => r.eventId === "dp:dp_smoke_1" && r.amountCents === 500)
  );

  /* ------------------------------------------------------ annual ----------------- */
  console.log("\nbooks annual at its monthly equivalent");
  await post(signedRequest(annualProSession()));
  let annualLedger = await ledgerFor(ANNUAL_USER);
  check(
    "annual checkout books +417, not +500",
    annualLedger.length === 1 && annualLedger[0]?.mrrDeltaCents === 417,
    JSON.stringify(annualLedger.map((r) => `${r.kind}${r.mrrDeltaCents}`))
  );

  // THE -83 REGRESSION GUARD. The optimistic grant said 417; the real subscription object
  // also says 417, so there is no movement and no row. If the checkout branch ever loses
  // the billing-period metadata it books 500 here and this fires.
  await post(signedRequest(annualSubEvent("customer.subscription.updated")));
  annualLedger = await ledgerFor(ANNUAL_USER);
  check(
    "the following subscription event books no spurious contraction",
    annualLedger.length === 1,
    JSON.stringify(annualLedger.map((r) => `${r.kind}${r.mrrDeltaCents}`))
  );

  const annualRow = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, ANNUAL_USER),
  });
  check("the monthly value is remembered on the mirror", annualRow?.subscriptionMonthlyCents === 417);
  check("…alongside the interval, for display", annualRow?.subscriptionInterval === "year");

  console.log("\nbooks terminal churn even when the period end has not passed");
  // `customer.subscription.deleted` fires AT the period end. Re-deriving the value from
  // `periodEnd > now` returns the full amount on any clock skew, classifyMovement sees no
  // change, and the churn is never recorded — with no later event to correct it.
  await post(
    signedRequest(
      annualSubEvent(
        "customer.subscription.deleted",
        { status: "active" },
        "evt_smoke_annual_del"
      )
    )
  );
  annualLedger = await ledgerFor(ANNUAL_USER);
  check(
    "a deleted subscription churns at -417 despite a future period end",
    annualLedger.some((r) => r.kind === "churn" && r.mrrDeltaCents === -417),
    JSON.stringify(annualLedger.map((r) => `${r.kind}${r.mrrDeltaCents}`))
  );

  /* ------------------------------------------------- lifetime cash --------------- */
  console.log("\nbooks Lifetime cash into the ledger");
  const lifetimeLedger = await ledgerFor(USER);
  const lifetimeRows = lifetimeLedger.filter((r) => r.kind === "lifetime");
  check("the Lifetime purchase left a ledger row at all", lifetimeRows.length === 1, String(lifetimeRows.length));
  check(
    "…keyed on the session, so both fulfil events collapse onto it",
    lifetimeRows[0]?.eventId === "cs:cs_test_smoke_1",
    String(lifetimeRows[0]?.eventId)
  );
  check("…with zero MRR delta", lifetimeRows[0]?.mrrDeltaCents === 0);

  // The two fulfil event types carry DIFFERENT event ids for the same purchase.
  const asyncFulfil = sessionEvent({ amount_total: 2500 }) as Record<string, unknown>;
  asyncFulfil.id = "evt_smoke_async_variant";
  asyncFulfil.type = "checkout.session.async_payment_succeeded";
  await post(signedRequest(asyncFulfil));
  check(
    "the async fulfil event does not double-book the purchase",
    (await ledgerFor(USER)).filter((r) => r.kind === "lifetime").length === 1
  );

  /* ------------------------------------------------- delivery telemetry ---------- */
  console.log("\nrecords its own deliveries");
  const deliveries = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.source, "stripe"));
  check("stripe deliveries are recorded at all", deliveries.length > 0, String(deliveries.length));
  check(
    "including the ones rejected for a bad signature",
    deliveries.some((d) => d.outcome === "invalid"),
    JSON.stringify(deliveries.map((d) => d.outcome))
  );
  check(
    "and they are attributed to stripe, not clerk",
    deliveries.every((d) => d.source === "stripe")
  );

  /* ------------------------------------------------------ reconciliation --------- */
  console.log("\nreconciles the two derivations of MRR");
  const clean = await mrrReconciliation();
  check(
    "drift is reported as live minus ledger",
    clean.driftCents === clean.liveCents - clean.ledgerCents,
    JSON.stringify(clean)
  );
  // Proving the alarm FIRES matters as much as proving it is quiet: an alarm that never
  // fires is indistinguishable from a broken one.
  await db.delete(billingEvents).where(eq(billingEvents.eventId, "in:in_smoke_1"));
  await db.insert(billingEvents).values({
    source: "stripe",
    eventId: "evt_smoke_drift_probe",
    kind: "new",
    userId: CASH_USER,
    amountCents: 0,
    mrrDeltaCents: 12345,
    effectiveAt: new Date(),
    detail: {},
  });
  const drifted = await mrrReconciliation();
  check(
    "a phantom ledger row moves the drift",
    drifted.driftCents !== clean.driftCents,
    `${clean.driftCents} -> ${drifted.driftCents}`
  );

  for (const u of [USER, PRO_USER, CASH_USER, ANNUAL_USER]) {
    await db.delete(billingEvents).where(eq(billingEvents.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
  }
  await db.delete(webhookDeliveries).where(eq(webhookDeliveries.source, "stripe"));
  console.log("\nAll Stripe webhook checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
