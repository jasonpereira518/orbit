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

const TEST_SECRET = "whsec_test_smoke_only_not_a_real_secret";
process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
process.env.STRIPE_SECRET_KEY ||= "sk_test_smoke_only_not_a_real_key";

import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings, billingEvents } from "../src/db/schema";
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
  // (new +500), wrong-product event (ignored, no row at all), unpaid (churn -500).
  const proLedger = await db
    .select()
    .from(billingEvents)
    .where(eq(billingEvents.userId, PRO_USER));
  check("exactly 4 movements recorded", proLedger.length === 4, String(proLedger.length));
  check(
    "two 'new' entries at +500",
    proLedger.filter((r) => r.kind === "new" && r.mrrDeltaCents === 500).length === 2
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

  await db.delete(billingEvents).where(eq(billingEvents.userId, USER));
  await db.delete(billingEvents).where(eq(billingEvents.userId, PRO_USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, PRO_USER));
  console.log("\nAll Stripe webhook checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
