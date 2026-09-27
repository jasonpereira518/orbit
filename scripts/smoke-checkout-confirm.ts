/**
 * Verify-on-return (launch Phase 2, audit B2): the return path grants what the webhook would,
 * refuses sessions that are not the caller's or were reversed, and a late webhook is a no-op.
 *
 * Run: npx tsx scripts/smoke-checkout-confirm.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

const TEST_SECRET = "whsec_test_smoke_confirm_only";
process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
process.env.STRIPE_SECRET_KEY ||= "sk_test_smoke_only_not_a_real_key";

import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { billingEvents, userSettings } from "../src/db/schema";
import { POST } from "../src/app/api/webhooks/stripe/route";
import { checkoutSessionVerdict } from "../src/lib/checkout-confirm";
import { confirmCheckoutForUser } from "../src/lib/stripe-fulfilment";
import { ensureUserSettings } from "../src/lib/user-settings";
import {
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
  PRO_BILLING_PERIOD_METADATA_KEY,
  PRO_METADATA_VALUE,
} from "../src/lib/stripe";

const LIFE = "smoke-confirm-life";
const PRO = "smoke-confirm-pro";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const nowSec = () => Math.floor(Date.now() / 1000);

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function session(over: Record<string, unknown>): Stripe.Checkout.Session {
  return {
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    created: nowSec() - 60,
    currency: "usd",
    ...over,
  } as unknown as Stripe.Checkout.Session;
}

const lifetime = (over: Record<string, unknown> = {}) =>
  session({
    id: "cs_test_confirm_life",
    mode: "payment",
    client_reference_id: LIFE,
    customer: "cus_confirm_life",
    amount_total: 4900,
    metadata: { [LIFETIME_METADATA_KEY]: LIFETIME_METADATA_VALUE },
    payment_intent: { id: "pi_1", latest_charge: { id: "ch_1", refunded: false, amount_refunded: 0, disputed: false } },
    ...over,
  });

const pro = (over: Record<string, unknown> = {}) =>
  session({
    id: "cs_test_confirm_pro",
    mode: "subscription",
    client_reference_id: PRO,
    customer: "cus_confirm_pro",
    amount_total: 500,
    metadata: { [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE, [PRO_BILLING_PERIOD_METADATA_KEY]: "monthly" },
    subscription: { id: "sub_confirm", status: "active" },
    ...over,
  });

const retrieving = (s: Stripe.Checkout.Session) => ({ retrieve: async () => s });

function webhookFor(s: Stripe.Checkout.Session, eventId: string) {
  const payload = JSON.stringify({ id: eventId, object: "event", type: "checkout.session.completed", created: nowSec(), data: { object: s } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_SECRET });
  const req = new Request("http://localhost/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": header }, body: payload });
  return POST(req as unknown as Parameters<typeof POST>[0]);
}

async function row(userId: string) {
  const db = await getDb();
  return db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
}
async function ledger(userId: string) {
  const db = await getDb();
  return db.select().from(billingEvents).where(eq(billingEvents.userId, userId));
}

async function main() {
  const db = await getDb();
  for (const u of [LIFE, PRO]) {
    await db.delete(billingEvents).where(eq(billingEvents.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
    await ensureUserSettings(u);
  }

  console.log("The verdict");
  const v = (s: Stripe.Checkout.Session, userId = LIFE) => checkoutSessionVerdict(s, { userId, nowSeconds: nowSec() });
  check("a paid, recent, own session passes", v(lifetime()).ok);
  check("someone else's session is refused", !v(lifetime(), "someone-else").ok);
  check("an open session is refused", !v(lifetime({ status: "open" })).ok);
  check("a session older than a day is refused", !v(lifetime({ created: nowSec() - 2 * 86400 })).ok);
  check("a refunded charge is refused", !v(lifetime({ payment_intent: { id: "pi", latest_charge: { refunded: true, amount_refunded: 4900, disputed: false } } })).ok);
  check("a disputed charge is refused", !v(lifetime({ payment_intent: { id: "pi", latest_charge: { refunded: false, amount_refunded: 0, disputed: true } } })).ok);
  check("an unexpanded charge is refused rather than trusted", !v(lifetime({ payment_intent: "pi_unexpanded" })).ok);
  check("a canceled subscription is refused", !v(pro({ subscription: { id: "s", status: "canceled" } }), PRO).ok);

  console.log("\nLifetime on return, then the late webhook");
  check("someone else cannot confirm it", (await confirmCheckoutForUser("someone-else", "cs_test_confirm_life", retrieving(lifetime()))).status === "skipped");
  const applied = await confirmCheckoutForUser(LIFE, "cs_test_confirm_life", retrieving(lifetime()));
  check("the return path applies", applied.status === "applied", JSON.stringify(applied));
  const granted = (await row(LIFE))?.lifetimePurchasedAt;
  check("Lifetime is granted without any webhook", Boolean(granted));
  check("its cash is booked once, on the session", (await ledger(LIFE)).filter((r) => r.eventId === "cs:cs_test_confirm_life").length === 1);
  check("the late webhook -> 200", (await webhookFor(lifetime(), "evt_confirm_life")).status === 200);
  check("...keeps the first timestamp", (await row(LIFE))?.lifetimePurchasedAt?.getTime() === granted?.getTime());
  check("...and books nothing new", (await ledger(LIFE)).length === 1);

  console.log("\nPro: return path and webhook racing");
  await Promise.all([
    confirmCheckoutForUser(PRO, "cs_test_confirm_pro", retrieving(pro())),
    webhookFor(pro(), "evt_confirm_pro"),
  ]);
  const proRow = await row(PRO);
  check("Pro is granted", proRow?.subscriptionPlan === "orbit" && proRow?.subscriptionStatus === "active");
  const movements = (await ledger(PRO)).filter((r) => r.mrrDeltaCents !== 0);
  check("exactly one MRR movement, keyed on the session", movements.length === 1 && movements[0]?.eventId === "csm:cs_test_confirm_pro", JSON.stringify(movements.map((m) => m.eventId)));

  for (const u of [LIFE, PRO]) {
    await db.delete(billingEvents).where(eq(billingEvents.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
  }
  console.log("\nAll checkout-confirm checks passed.");
}

run(main);
