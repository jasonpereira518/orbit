/**
 * The small readers `decideStripeEvent` is built from, and two decisions whose meaning was
 * questioned in review.
 *
 * The readers exist because Stripe's payload shape moved across API versions and the SDK is
 * not pinned here: `current_period_end` went from the subscription root to its item, the
 * invoice's subscription went from the root to `parent.subscription_details`. Each reader
 * accepts both, and a regression in one would not throw — it would quietly book $0 MRR or
 * leave a period end null. So each shape is pinned, old and new.
 *
 * The two decisions:
 *
 *  - An IMMEDIATE cancellation (`customer.subscription.deleted` while `current_period_end` is
 *    still ahead) keeps paid access until that period end. That is the documented policy in
 *    `subscriptionIsLive` (src/lib/entitlements.ts: "A canceled subscription keeps working
 *    until the period the user already paid for runs out"), it books the churn at once, and
 *    a refund withdraws access through its own `subscription_revoked` path — so it is pinned
 *    here as intended, not filed as a bug. (What a refund followed by a later `deleted` does
 *    is a different question: see smoke-stripe-revocation-regrant.)
 *  - A credit pack is granted with `stripeRef = paymentIntentId ?? session.id` and revoked by
 *    payment intent. Suspected mismatch; it is not one: whenever the session paid anything it
 *    carries a payment intent, so the grant and a later refund name the same id. The
 *    session-id fallback only applies to a session with no payment intent, which has no
 *    charge for a refund to name. Pinned through `applyStripeDecision` with recording deps.
 *
 * Pure: no database, no network. Run: npx tsx scripts/smoke-billing-helpers.ts
 */
import type Stripe from "stripe";
import {
  addMonthsSeconds,
  decideStripeEvent,
  foundingOffAt,
  foundingTerms,
  intervalFromAmountTotal,
  invoiceSubscriptionId,
  monthlyEquivalentCents,
  periodEndOf,
  stripeEventSubject,
  type DecideContext,
} from "../src/lib/billing-stripe";
import { resolvePlan } from "../src/lib/entitlements";
import {
  CREDIT_PACK_METADATA_VALUE,
  FOUNDING_MONTHS,
  FOUNDING_OFF_METADATA_KEY,
  FOUNDING_UNTIL_METADATA_KEY,
  LIFETIME_METADATA_KEY,
  PRO_METADATA_VALUE,
  SUBSCRIPTION_USER_METADATA_KEY,
} from "../src/lib/stripe-config";
import { applyStripeDecision, type StripeApplyDeps } from "../src/lib/stripe-fulfilment";
import { checker } from "./smoke/check";

const t = checker();
const NOW = new Date("2026-10-01T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const DAY_S = 86_400;
const USER = "user_billing_helpers";

const sub = (over: Record<string, unknown>) => over as unknown as Stripe.Subscription;
const inv = (over: Record<string, unknown>) => over as unknown as Stripe.Invoice;
const evt = (type: string, object: Record<string, unknown>, id = `evt_${type}`) =>
  ({ id, object: "event", type, created: NOW_S, data: { object } }) as unknown as Stripe.Event;

console.log("\nmonthlyEquivalentCents");
t.check("no price → null (unknown, not zero)", monthlyEquivalentCents(null) === null && monthlyEquivalentCents(undefined) === null);
t.check("no unit_amount → null", monthlyEquivalentCents({ recurring: { interval: "month" } }) === null);
t.check("one-time price (no recurring) → null", monthlyEquivalentCents({ unit_amount: 500, recurring: null }) === null);
t.check("unknown interval → null", monthlyEquivalentCents({ unit_amount: 500, recurring: { interval: "fortnight" } }) === null);
t.check("monthly 500 → 500", monthlyEquivalentCents({ unit_amount: 500, recurring: { interval: "month" } }) === 500);
t.check("quarterly (month × 3) 1500 → 500", monthlyEquivalentCents({ unit_amount: 1500, recurring: { interval: "month", interval_count: 3 } }) === 500);
t.check("annual 6000 → 500", monthlyEquivalentCents({ unit_amount: 6000, recurring: { interval: "year" } }) === 500);
t.check("annual 5000 → 417 (rounded)", monthlyEquivalentCents({ unit_amount: 5000, recurring: { interval: "year" } }) === 417);
t.check("weekly 100 → 433", monthlyEquivalentCents({ unit_amount: 100, recurring: { interval: "week" } }) === 433);
t.check("daily 10 → 304", monthlyEquivalentCents({ unit_amount: 10, recurring: { interval: "day" } }) === 304);
t.check("quantity multiplies", monthlyEquivalentCents({ unit_amount: 500, recurring: { interval: "month" } }, 3) === 1500);
t.check("quantity 0 counts as one seat", monthlyEquivalentCents({ unit_amount: 500, recurring: { interval: "month" } }, 0) === 500);
t.check("interval_count 0 / null counts as 1", monthlyEquivalentCents({ unit_amount: 500, recurring: { interval: "month", interval_count: 0 } }) === 500 && monthlyEquivalentCents({ unit_amount: 500, recurring: { interval: "month", interval_count: null } }) === 500);

console.log("\nperiodEndOf");
t.check("reads the item (new API versions)", periodEndOf(sub({ id: "sub_1", items: { data: [{ current_period_end: 111 }] } })) === 111);
t.check("item wins over root", periodEndOf(sub({ id: "sub_1", current_period_end: 222, items: { data: [{ current_period_end: 111 }] } })) === 111);
t.check("falls back to the root (old API versions)", periodEndOf(sub({ id: "sub_1", current_period_end: 222, items: { data: [{}] } })) === 222);
t.check("no items at all still reads the root", periodEndOf(sub({ id: "sub_1", current_period_end: 333 })) === 333);
const origError = console.error;
console.error = () => {};
const missing = periodEndOf(sub({ id: "sub_none", items: { data: [] } }));
console.error = origError;
t.check("neither → null, never 0 or NaN", missing === null);

console.log("\ninvoiceSubscriptionId");
t.check("root string", invoiceSubscriptionId(inv({ subscription: "sub_root" })) === "sub_root");
t.check("root expanded object", invoiceSubscriptionId(inv({ subscription: { id: "sub_obj" } })) === "sub_obj");
t.check("nested parent.subscription_details string", invoiceSubscriptionId(inv({ parent: { subscription_details: { subscription: "sub_nested" } } })) === "sub_nested");
t.check("nested expanded object", invoiceSubscriptionId(inv({ parent: { subscription_details: { subscription: { id: "sub_nested_obj" } } } })) === "sub_nested_obj");
t.check("root wins over nested", invoiceSubscriptionId(inv({ subscription: "sub_root", parent: { subscription_details: { subscription: "sub_nested" } } })) === "sub_root");
t.check("one-off invoice (no subscription anywhere) → null", invoiceSubscriptionId(inv({ parent: null })) === null && invoiceSubscriptionId(inv({})) === null);
t.check("an object without an id is not an id", invoiceSubscriptionId(inv({ subscription: {} })) === null);

console.log("\nintervalFromAmountTotal");
t.check("5000 → year", intervalFromAmountTotal(5000) === "year");
t.check("500 → month", intervalFromAmountTotal(500) === "month");
t.check("anything else → null", intervalFromAmountTotal(700) === null && intervalFromAmountTotal(0) === null);
t.check("null / undefined → null", intervalFromAmountTotal(null) === null && intervalFromAmountTotal(undefined) === null);

console.log("\nfoundingTerms / foundingOffAt");
const START = Date.UTC(2026, 0, 31, 10) / 1000; // Jan 31: month arithmetic's awkward case
t.check("no metadata → no founding pricing", foundingTerms(null, START) === null && foundingTerms({}, START) === null);
t.check("zero / negative / junk off → null", foundingTerms({ [FOUNDING_OFF_METADATA_KEY]: "0" }, START) === null && foundingTerms({ [FOUNDING_OFF_METADATA_KEY]: "-200" }, START) === null && foundingTerms({ [FOUNDING_OFF_METADATA_KEY]: "abc" }, START) === null);
const stamped = foundingTerms({ [FOUNDING_OFF_METADATA_KEY]: "200", [FOUNDING_UNTIL_METADATA_KEY]: "1800000000" }, START);
t.check("an explicit window end wins", stamped?.offCents === 200 && stamped.until === 1_800_000_000, JSON.stringify(stamped));
const derived = foundingTerms({ [FOUNDING_OFF_METADATA_KEY]: "200" }, START);
t.check(`no stamp → start + ${FOUNDING_MONTHS} calendar months`, derived?.until === addMonthsSeconds(START, FOUNDING_MONTHS), JSON.stringify(derived));
t.check("no stamp and no start → open-ended (until null)", foundingTerms({ [FOUNDING_OFF_METADATA_KEY]: "200" }, null)?.until === null);
t.check("fractional cents are rounded", foundingTerms({ [FOUNDING_OFF_METADATA_KEY]: "199.6" }, START)?.offCents === 200);
t.check("junk stamp falls back to the derived window", foundingTerms({ [FOUNDING_OFF_METADATA_KEY]: "200", [FOUNDING_UNTIL_METADATA_KEY]: "soon" }, START)?.until === addMonthsSeconds(START, FOUNDING_MONTHS));
t.check("foundingOffAt(null) → 0", foundingOffAt(null, NOW_S) === 0);
t.check("inside the window → the discount", foundingOffAt({ offCents: 200, until: NOW_S + 1 }, NOW_S) === 200);
t.check("at the window end → 0 (end is exclusive)", foundingOffAt({ offCents: 200, until: NOW_S }, NOW_S) === 0);
t.check("after the window → 0", foundingOffAt({ offCents: 200, until: NOW_S - 1 }, NOW_S) === 0);
t.check("open-ended window → the discount forever", foundingOffAt({ offCents: 200, until: null }, NOW_S + 10 * 365 * DAY_S) === 200);

console.log("\nstripeEventSubject");
const s1 = stripeEventSubject(evt("checkout.session.completed", { id: "cs_1", client_reference_id: "user_a", customer: "cus_1", metadata: { [SUBSCRIPTION_USER_METADATA_KEY]: "user_b" } }));
t.check("client_reference_id is the first hint", s1.userIdHint === "user_a" && s1.customerId === "cus_1" && s1.resourceId === "cs_1");
const s2 = stripeEventSubject(evt("customer.subscription.updated", { id: "sub_1", customer: { id: "cus_2" }, metadata: { [SUBSCRIPTION_USER_METADATA_KEY]: "user_b" } }));
t.check("subscription metadata is the next hint; an expanded customer reads its id", s2.userIdHint === "user_b" && s2.customerId === "cus_2");
const s3 = stripeEventSubject(evt("invoice.paid", { id: "in_1", customer: "cus_3" }));
t.check("no hint → null, customer still read for the stored-link lookup", s3.userIdHint === null && s3.customerId === "cus_3");
const s4 = stripeEventSubject(evt("charge.refunded", { customer: null, client_reference_id: "" }));
t.check("no id, no customer, empty reference → all null", s4.userIdHint === null && s4.customerId === null && s4.resourceId === null);

console.log("\nImmediate cancellation: access to the paid period end (by design)");
const periodEnd = NOW_S + 20 * DAY_S;
const ctx: DecideContext = { userId: USER, beforeCents: 500, hadPriorRevenue: true, now: NOW };
const immediate = decideStripeEvent(
  evt("customer.subscription.deleted", {
    id: "sub_immediate",
    object: "subscription",
    status: "canceled",
    customer: "cus_immediate",
    metadata: { [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE, [SUBSCRIPTION_USER_METADATA_KEY]: USER },
    items: { data: [{ id: "si_1", quantity: 1, current_period_start: NOW_S - 10 * DAY_S, current_period_end: periodEnd, price: { unit_amount: 500, recurring: { interval: "month" } } }] },
  }),
  ctx
);
const mirror = immediate.mirror;
t.check(
  "mirror: canceled, paid through the period end Stripe reports",
  mirror?.type === "subscription" && mirror.status === "canceled" && mirror.periodEnd === periodEnd && mirror.plan === "orbit",
  JSON.stringify(mirror)
);
t.check(
  "the churn is booked immediately (MRR -500), not at the period end",
  immediate.bookings.length === 1 && immediate.bookings[0].kind === "churn" && immediate.bookings[0].mrrDeltaCents === -500,
  JSON.stringify(immediate.bookings)
);
const row = { subscriptionPlan: "orbit" as const, subscriptionStatus: "canceled" as const, subscriptionPeriodEnd: new Date(periodEnd * 1000) };
t.check("resolvePlan honours the paid period after cancellation", resolvePlan(row, NOW).plan === "orbit");
t.check("…and drops to free once it has run out", resolvePlan(row, new Date((periodEnd + 1) * 1000)).plan === "free");

async function creditPackRefs() {
  console.log("\nCredit pack: the grant's ref is what a refund revokes by");
  type Call = { name: string; args: unknown[] };
  const calls: Call[] = [];
  const deps: StripeApplyDeps = {
    revokeLifetime: async (...args) => void calls.push({ name: "revokeLifetime", args }) as never,
    book: async (booking) => void calls.push({ name: "book", args: [booking] }),
    setLifetime: async (...args) => void calls.push({ name: "setLifetime", args }) as never,
    setSubscription: async (...args) => void calls.push({ name: "setSubscription", args }) as never,
    grantPack: async (input) => (calls.push({ name: "grantPack", args: [input] }), true),
    revokePack: async (input) => (calls.push({ name: "revokePack", args: [input] }), 0),
    recordFounding: async (...args) => void calls.push({ name: "recordFounding", args }) as never,
    setCustomer: async (...args) => void calls.push({ name: "setCustomer", args }),
  };
  const packSession = (pi: string | null) =>
    evt("checkout.session.completed", {
      id: "cs_pack_1",
      object: "checkout.session",
      client_reference_id: USER,
      payment_status: "paid",
      amount_total: 500,
      customer: "cus_pack",
      payment_intent: pi,
      metadata: { [LIFETIME_METADATA_KEY]: CREDIT_PACK_METADATA_VALUE },
    });

  await applyStripeDecision(decideStripeEvent(packSession("pi_pack_1"), { ...ctx, beforeCents: 0 }), deps);
  const grant = calls.find((c) => c.name === "grantPack")?.args[0] as { stripeRef: string; grantKey: string } | undefined;
  t.check("a paid pack is granted keyed by its session", grant?.grantKey === "pack:cs:cs_pack_1", JSON.stringify(grant));
  t.check("…with the payment intent as its stripe ref", grant?.stripeRef === "pi_pack_1");

  calls.length = 0;
  const refund = decideStripeEvent(
    evt("charge.refunded", {
      id: "ch_pack_1",
      object: "charge",
      customer: "cus_pack",
      payment_intent: "pi_pack_1",
      amount_captured: 500,
      amount_refunded: 500,
      refunded: true,
      refunds: { data: [{ id: "re_pack_1", amount: 500, created: NOW_S }] },
    }),
    { ...ctx, chargePurpose: "credit_pack" }
  );
  await applyStripeDecision(refund, deps);
  const revoke = calls.find((c) => c.name === "revokePack")?.args[0] as { paymentIntentId: string } | undefined;
  t.check("a full refund of that charge revokes by the same payment intent", revoke?.paymentIntentId === grant?.stripeRef, JSON.stringify(revoke));

  calls.length = 0;
  await applyStripeDecision(decideStripeEvent(packSession(null), { ...ctx, beforeCents: 0 }), deps);
  const free = calls.find((c) => c.name === "grantPack")?.args[0] as { stripeRef: string } | undefined;
  t.check("a session with no payment intent (nothing charged) falls back to the session id", free?.stripeRef === "cs_pack_1");
}

creditPackRefs().then(
  () => t.done("billing helpers"),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
