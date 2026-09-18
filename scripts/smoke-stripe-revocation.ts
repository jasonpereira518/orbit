/**
 * Pins what a refund or a lost dispute MEANS, in the pure Stripe decision module.
 *
 * Before this, `charge.refunded` and `charge.dispute.closed` returned `mirror: null`: a
 * refunded Lifetime kept Lifetime forever and a charged-back Pro kept Pro until the
 * subscription lapsed on its own (audit A4). The decision now withdraws access on a FULL
 * refund or a LOST dispute — and only once the driver has said what the charge paid for,
 * because this module never looks anything up.
 *
 * Also re-asserts the ledger invariant on every decision it makes: no booking row carries
 * both cash and MRR.
 *
 * Pure: no database, no network. Run: npx tsx scripts/smoke-stripe-revocation.ts
 */
import type Stripe from "stripe";
import {
  decideStripeEvent,
  isFullRefund,
  revocationPaymentIntent,
  type ChargePurpose,
  type DecideContext,
  type StripeDecision,
} from "../src/lib/billing-stripe";
import { LIFETIME_METADATA_KEY, LIFETIME_METADATA_VALUE } from "../src/lib/stripe";
import {
  resolveChargePurpose,
  type ChargePurposeLookups,
} from "../src/lib/stripe-charge-purpose";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-09-15T12:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const USER = "user_revocation";

function ctx(chargePurpose?: ChargePurpose, beforeCents = 500): DecideContext {
  return { userId: USER, beforeCents, hadPriorRevenue: true, now: NOW, chargePurpose };
}

function event(type: string, object: Record<string, unknown>, id = `evt_${type}`): Stripe.Event {
  return {
    id,
    object: "event",
    type,
    created: NOW_SECONDS,
    data: { object },
  } as unknown as Stripe.Event;
}

function charge(over: Record<string, unknown> = {}) {
  return {
    id: "ch_1",
    object: "charge",
    customer: "cus_1",
    currency: "usd",
    payment_intent: "pi_1",
    amount: 2500,
    amount_captured: 2500,
    amount_refunded: 2500,
    refunded: true,
    refunds: {
      object: "list",
      data: [{ id: "re_1", object: "refund", amount: 2500, created: NOW_SECONDS, reason: "requested_by_customer" }],
    },
    ...over,
  };
}

function dispute(over: Record<string, unknown> = {}) {
  return {
    id: "dp_1",
    object: "dispute",
    charge: "ch_1",
    payment_intent: "pi_1",
    customer: "cus_1",
    amount: 2500,
    reason: "fraudulent",
    status: "lost",
    ...over,
  };
}

const refunded = (purpose?: ChargePurpose, over: Record<string, unknown> = {}, before = 500) =>
  decideStripeEvent(event("charge.refunded", charge(over), "evt_refund"), ctx(purpose, before));
const disputeClosed = (purpose?: ChargePurpose, over: Record<string, unknown> = {}, before = 500) =>
  decideStripeEvent(event("charge.dispute.closed", dispute(over), "evt_dispute"), ctx(purpose, before));

function neverBoth(d: StripeDecision): boolean {
  return d.bookings.every((b) => !((b.amountCents ?? 0) !== 0 && (b.mrrDeltaCents ?? 0) !== 0));
}

async function main() {
  console.log("Which events even need a lookup");
  check("a full refund names its payment intent",
    revocationPaymentIntent(event("charge.refunded", charge())) === "pi_1");
  check("a partial refund needs none",
    revocationPaymentIntent(event("charge.refunded", charge({ refunded: false, amount_refunded: 1000 }))) === null);
  check("a full refund without Stripe's flag is still full (amounts)",
    isFullRefund({ refunded: false, amount_refunded: 2500, amount_captured: 2500 }));
  check("an uncaptured charge is never 'fully refunded'",
    !isFullRefund({ refunded: false, amount_refunded: 0, amount_captured: 0 }));
  check("a lost dispute names its payment intent",
    revocationPaymentIntent(event("charge.dispute.closed", dispute())) === "pi_1");
  check("a won dispute needs none",
    revocationPaymentIntent(event("charge.dispute.closed", dispute({ status: "won" }))) === null);
  check("an expanded payment intent object is read by id",
    revocationPaymentIntent(event("charge.refunded", charge({ payment_intent: { id: "pi_obj" } }))) === "pi_obj");
  check("other event types need none",
    revocationPaymentIntent(event("invoice.paid", { id: "in_1" })) === null);

  console.log("\nA full refund of the Lifetime charge");
  const life = refunded("lifetime");
  check("withdraws Lifetime",
    life.mirror?.type === "lifetime_revoked" && life.mirror.userId === USER && life.mirror.reason === "refund",
    JSON.stringify(life.mirror));
  check("still books the refund cash, keyed on the refund",
    life.bookings.some((b) => b.eventId === "re:re_1" && b.amountCents === 2500 && (b.mrrDeltaCents ?? 0) === 0));
  check("books no MRR row (Lifetime never had recurring revenue)",
    life.bookings.every((b) => (b.mrrDeltaCents ?? 0) === 0));
  check("is handled", life.outcome === "handled");

  console.log("\nA full refund of a subscription charge");
  const sub = refunded("subscription");
  check("cancels the subscription as of now",
    sub.mirror?.type === "subscription_revoked" && sub.mirror.periodEnd === NOW_SECONDS && sub.mirror.reason === "refund",
    JSON.stringify(sub.mirror));
  const churn = sub.bookings.find((b) => b.kind === "churn");
  check("books one churn row, keyed on the event",
    churn?.eventId === "evt_refund" && churn.mrrDeltaCents === -500 && (churn.amountCents ?? 0) === 0,
    JSON.stringify(churn));
  check("keeps the cash row separate", sub.bookings.some((b) => b.eventId === "re:re_1"));
  const already = refunded("subscription", {}, 0);
  check("an already-lapsed subscription is canceled but churns nothing twice",
    already.mirror?.type === "subscription_revoked" && !already.bookings.some((b) => b.kind === "churn"));

  console.log("\nWhat does NOT revoke");
  check("purpose unknown → no mirror", refunded("unknown").mirror === null);
  check("no purpose at all (the backfill replays like this) → no mirror", refunded(undefined).mirror === null);
  check("a partial refund of the Lifetime charge → no mirror",
    refunded("lifetime", { refunded: false, amount_refunded: 1000 }).mirror === null);
  const unexpanded = refunded("lifetime", { refunds: { object: "list", data: [] } });
  check("a full refund whose refunds were not expanded still revokes",
    unexpanded.outcome === "handled" && unexpanded.mirror?.type === "lifetime_revoked",
    JSON.stringify(unexpanded));
  const quiet = refunded("unknown", { refunds: { object: "list", data: [] } });
  check("…but with nothing to book and nothing to revoke it is still ignored",
    quiet.outcome === "ignored" && quiet.mirror === null);

  console.log("\nDisputes");
  const lostLife = disputeClosed("lifetime");
  check("a lost dispute on the Lifetime charge withdraws Lifetime",
    lostLife.mirror?.type === "lifetime_revoked" && lostLife.mirror.reason === "dispute_lost");
  check("…and still books the lost cash on the dispute",
    lostLife.bookings.some((b) => b.eventId === "dp:dp_1" && b.amountCents === 2500));
  const lostSub = disputeClosed("subscription");
  check("a lost dispute on a subscription charge cancels it now",
    lostSub.mirror?.type === "subscription_revoked" && lostSub.mirror.reason === "dispute_lost");
  const won = disputeClosed("lifetime", { status: "won" });
  check("a won dispute changes nothing", won.mirror === null && won.outcome === "ignored");

  console.log("\nThe Lifetime purchase remembers how it was paid");
  const purchase = decideStripeEvent(
    event("checkout.session.completed", {
      id: "cs_1",
      object: "checkout.session",
      client_reference_id: USER,
      payment_status: "paid",
      customer: "cus_1",
      payment_intent: "pi_life",
      amount_total: 2500,
      currency: "usd",
      metadata: { [LIFETIME_METADATA_KEY]: LIFETIME_METADATA_VALUE },
    }),
    ctx()
  );
  check("the cs: booking carries paymentIntentId",
    purchase.bookings[0]?.detail.paymentIntentId === "pi_life",
    JSON.stringify(purchase.bookings[0]?.detail));

  console.log("\nResolving what a charge paid for (fake lookups)");
  function fakes(answers: { ledger?: boolean; plan?: string | null; invoice?: boolean }) {
    const calls: string[] = [];
    const lookups: ChargePurposeLookups = {
      async lifetimeOnLedger() { calls.push("ledger"); return answers.ledger ?? false; },
      async checkoutSessionPlan() { calls.push("session"); return answers.plan ?? null; },
      async hasInvoicePayment() { calls.push("invoice"); return answers.invoice ?? false; },
    };
    return { lookups, calls };
  }
  const none = fakes({});
  check("no payment intent → unknown, and nothing is asked",
    (await resolveChargePurpose(null, none.lookups)) === "unknown" && none.calls.length === 0);
  const onLedger = fakes({ ledger: true });
  check("a purchase on our own ledger is Lifetime without asking Stripe",
    (await resolveChargePurpose("pi_1", onLedger.lookups)) === "lifetime" && onLedger.calls.join() === "ledger",
    onLedger.calls.join());
  const oldPurchase = fakes({ plan: LIFETIME_METADATA_VALUE });
  check("an older purchase is found through its Checkout Session",
    (await resolveChargePurpose("pi_1", oldPurchase.lookups)) === "lifetime" && oldPurchase.calls.join() === "ledger,session");
  const subscription = fakes({ plan: null, invoice: true });
  check("a payment intent that paid an invoice is a subscription",
    (await resolveChargePurpose("pi_1", subscription.lookups)) === "subscription");
  check("nothing matches → unknown",
    (await resolveChargePurpose("pi_1", fakes({ plan: "something-else" }).lookups)) === "unknown");
  let propagated = false;
  await resolveChargePurpose("pi_1", {
    ...fakes({}).lookups,
    async checkoutSessionPlan() { throw new Error("stripe is down"); },
  }).catch(() => { propagated = true; });
  check("a lookup failure propagates (so the webhook 500s and Stripe retries)", propagated);

  console.log("\nThe ledger invariant");
  const all = [life, sub, already, unexpanded, lostLife, lostSub, won, purchase];
  check("no booking row anywhere carries both cash and MRR", all.every(neverBoth));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Stripe revocation checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
