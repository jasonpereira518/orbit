/**
 * Asserts that deleting an account in Clerk deletes it here too — including the settings
 * row — while the Settings "Delete data" path keeps that row on purpose.
 *
 * The two paths look alike and must not behave alike. "Delete data" runs for someone who is
 * still signed in, so their email, name and encrypted provider keys survive it
 * (`purgeUserData`'s default `keepSettings: true`). A `user.deleted` webhook means the
 * account no longer exists; keeping the row there left the person's identity, live
 * third-party API keys and Stripe customer id in the admin roster forever (audit A2).
 *
 * Drives the real webhook route with a real Standard Webhooks signature computed here —
 * no Clerk account, no network.
 *
 * Run: npx tsx scripts/smoke-account-deletion.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { createHmac } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import Stripe from "stripe";
import { getDb } from "../src/db";
import {
  billingEvents,
  contacts,
  productEvents,
  stripeProcessedEvents,
  userSettings,
  webhookDeliveries,
} from "../src/db/schema";
import { deleteOwnAccount, type AccountDeletionDeps } from "../src/lib/account-deletion";
import { mrrReconciliation, recordBillingEventStrict } from "../src/lib/billing-events";
import { purgeUserData } from "../src/lib/user-data";
import { ensureUserSettings, setSubscriptionState } from "../src/lib/user-settings";
import { POST as clerkPost } from "../src/app/api/webhooks/clerk/route";
import { POST as stripePost } from "../src/app/api/webhooks/stripe/route";
import { SUBSCRIPTION_USER_METADATA_KEY, PRO_METADATA_VALUE, LIFETIME_METADATA_KEY } from "../src/lib/stripe";

// A real base64 secret: `verifyWebhook` strips `whsec_` and base64-decodes the rest, so the
// HMAC below is a signature it genuinely accepts. It reads the variable at call time, so
// setting it after the imports is fine.
const SECRET_BYTES = Buffer.from("orbit-smoke-clerk-signing-secret");
process.env.CLERK_WEBHOOK_SIGNING_SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const STRIPE_TEST_SECRET = "whsec_test_smoke_account_deletion_only";
process.env.STRIPE_WEBHOOK_SECRET = STRIPE_TEST_SECRET;
process.env.STRIPE_SECRET_KEY ||= "sk_test_smoke_only_not_a_real_key";

const GONE = "smoke-deletion-webhook-user";
const KEPT = "smoke-deletion-settings-user";
const DELIVERY_IDS = ["msg_smoke_deletion_1", "msg_smoke_deletion_2"];
const CIPHERTEXT = "smoke-ciphertext-not-a-real-key";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

function signedClerkRequest(payload: unknown, deliveryId: string) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", SECRET_BYTES)
    .update(`${deliveryId}.${timestamp}.${body}`)
    .digest("base64");
  return new Request("http://localhost/api/webhooks/clerk", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": deliveryId,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body,
  });
}

// The route is typed for NextRequest but only reads headers and text, which Request has.
const post = (req: Request) =>
  clerkPost(req as unknown as Parameters<typeof clerkPost>[0]);

async function cleanup() {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, [GONE, KEPT]));
  await db.delete(userSettings).where(inArray(userSettings.userId, [GONE, KEPT]));
  await db.delete(webhookDeliveries).where(inArray(webhookDeliveries.eventId, DELIVERY_IDS));
}

async function seed(userId: string) {
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({
      email: `${userId}@example.test`,
      firstName: "Fixture",
      geminiApiKeyEncrypted: CIPHERTEXT,
      stripeCustomerId: `cus_${userId}`,
    })
    .where(eq(userSettings.userId, userId));
  await db.insert(contacts).values({ userId, fullName: "Deletion Fixture" });
}

async function settingsRows(userId: string) {
  const db = await getDb();
  return db.select().from(userSettings).where(eq(userSettings.userId, userId));
}

async function contactRows(userId: string) {
  const db = await getDb();
  return db.select().from(contacts).where(eq(contacts.userId, userId));
}

run(async () => {
  await cleanup();
  await seed(GONE);
  await seed(KEPT);

  console.log("Clerk user.deleted — the account is gone, so nothing of it stays");
  const event = {
    type: "user.deleted",
    object: "event",
    data: { id: GONE, object: "user", deleted: true },
  };
  const res = await post(signedClerkRequest(event, DELIVERY_IDS[0]));
  check("the signed webhook is accepted", res.status === 200, String(res.status));
  const gone = await settingsRows(GONE);
  check(
    "a user.deleted webhook leaves no user_settings row",
    gone.length === 0,
    JSON.stringify(gone.map((r) => ({ email: r.email, key: r.geminiApiKeyEncrypted })))
  );
  check("…and no contacts", (await contactRows(GONE)).length === 0);

  const again = await post(signedClerkRequest(event, DELIVERY_IDS[1]));
  check(
    "a redelivery is harmless",
    again.status === 200 && (await settingsRows(GONE)).length === 0,
    String(again.status)
  );

  console.log("\nSettings → Delete data — still signed in, so the row stays");
  await purgeUserData(KEPT);
  const kept = await settingsRows(KEPT);
  check("the settings row survives", kept.length === 1, String(kept.length));
  check(
    "…with the saved provider key intact",
    kept[0]?.geminiApiKeyEncrypted === CIPHERTEXT,
    String(kept[0]?.geminiApiKeyEncrypted)
  );
  check("…and the identity mirror intact", kept[0]?.email === `${KEPT}@example.test`);
  check("…while the data itself is gone", (await contactRows(KEPT)).length === 0);


  /* ------------------------------------------------------------ billing: churn ---- */
  console.log("\nSelf-service deletion takes the subscription out of the ledger");
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const signedStripe = (event: unknown) => {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_TEST_SECRET });
    return new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": header, "content-type": "application/json" },
      body: payload,
    });
  };
  const postStripe = (req: Request) => stripePost(req as unknown as Parameters<typeof stripePost>[0]);

  const SUBSCRIBER = "smoke-deletion-subscriber";
  const RACED = "smoke-deletion-raced";
  const BROKEN_LEDGER = "smoke-deletion-broken-ledger";
  const LAPSED = "smoke-deletion-lapsed";
  const BILLING_USERS = [SUBSCRIBER, RACED, BROKEN_LEDGER, LAPSED];
  const db = await getDb();
  const fakeDeps = (): AccountDeletionDeps => ({
    async cancelSubscriptions() {},
    async deleteLogin() {},
  });
  const future = Math.floor(Date.now() / 1000) + 20 * 86_400;
  const past = Math.floor(Date.now() / 1000) - 20 * 86_400;

  async function cleanBilling() {
    await db.delete(billingEvents).where(inArray(billingEvents.userId, BILLING_USERS));
    await db.delete(billingEvents).where(sql`${billingEvents.eventId} LIKE 'del:smoke-deletion-%'`);
    await db.delete(userSettings).where(inArray(userSettings.userId, BILLING_USERS));
    await db.delete(stripeProcessedEvents);
  }
  async function seedSubscriber(
    userId: string,
    opts: { status?: "active" | "past_due" | "canceled"; periodEnd?: number; ledger?: boolean } = {}
  ) {
    await ensureUserSettings(userId);
    await setSubscriptionState(
      userId,
      {
        plan: "orbit",
        status: opts.status ?? "active",
        periodEnd: opts.periodEnd ?? future,
        monthlyCents: 899,
        interval: "month",
      },
      { stripeCustomerId: `cus_${userId}` }
    );
    if (opts.ledger !== false) {
      await recordBillingEventStrict({
        source: "stripe",
        eventId: `evt_seed_new_${userId}`,
        kind: "new",
        userId,
        mrrDeltaCents: 899,
        effectiveAt: new Date(Date.now() - 86_400_000),
      });
    }
  }
  async function churnRows() {
    return db
      .select()
      .from(billingEvents)
      .where(sql`${billingEvents.eventId} LIKE 'del:smoke-deletion-%'`);
  }
  async function accountDeletedEvents() {
    // track() writes after the response in production; outside a request it is a detached
    // promise, so give it a moment to land.
    for (let i = 0; i < 40; i++) {
      const rows = await db.select().from(productEvents).where(eq(productEvents.name, "account_deleted"));
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  }

  await cleanBilling();
  await db.delete(productEvents).where(eq(productEvents.name, "account_deleted"));
  const baseline = await mrrReconciliation();

  await seedSubscriber(SUBSCRIBER);
  const seeded = await mrrReconciliation();
  check(
    "a subscriber seeded through the ledger moves live MRR and ledger MRR alike",
    seeded.liveCents - baseline.liveCents === 899 && seeded.ledgerCents - baseline.ledgerCents === 899 && seeded.driftCents === baseline.driftCents,
    JSON.stringify({ baseline, seeded })
  );

  await deleteOwnAccount(SUBSCRIBER, fakeDeps());
  check("the account is gone", (await settingsRows(SUBSCRIBER)).length === 0);
  const churn = (await churnRows()).filter((r) => r.eventId.startsWith(`del:${SUBSCRIBER}:`));
  check("one churn row was booked, keyed del:<user>:<customer>", churn.length === 1 && churn[0]!.eventId === `del:${SUBSCRIBER}:cus_${SUBSCRIBER}`, JSON.stringify(churn.map((r) => r.eventId)));
  check("…for the subscription's full monthly value, negative, and no cash", churn[0]?.kind === "churn" && churn[0]?.mrrDeltaCents === -899 && churn[0]?.amountCents === 0, JSON.stringify(churn[0]));
  const afterDelete = await mrrReconciliation();
  check(
    "ledger MRR equals live MRR again after the purge (drift is back to baseline)",
    afterDelete.driftCents === baseline.driftCents && afterDelete.ledgerCents === baseline.ledgerCents && afterDelete.liveCents === baseline.liveCents,
    JSON.stringify({ baseline, afterDelete })
  );

  const deletedEvents = await accountDeletedEvents();
  check("one account_deleted product event was recorded", deletedEvents.length === 1, String(deletedEvents.length));
  check(
    "…with no user id, a plan and a tenure",
    deletedEvents[0]?.userId === null &&
      (deletedEvents[0]?.properties as { plan?: string })?.plan === "orbit" &&
      typeof (deletedEvents[0]?.properties as { tenure_days?: number })?.tenure_days === "number",
    JSON.stringify(deletedEvents[0])
  );

  // Stripe cancelled the subscription, so its deleted webhook arrives after the purge.
  const deletedEvent = (id: string, withUserHint: boolean) => ({
    id,
    object: "event",
    type: "customer.subscription.deleted",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: "sub_smoke_deleted",
        object: "subscription",
        customer: `cus_${SUBSCRIBER}`,
        status: "canceled",
        metadata: {
          [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE,
          ...(withUserHint ? { [SUBSCRIPTION_USER_METADATA_KEY]: SUBSCRIBER } : {}),
        },
        items: {
          data: [
            {
              id: "si_x",
              current_period_end: past,
              price: { id: "price_x", unit_amount: 899, recurring: { interval: "month", interval_count: 1 } },
            },
          ],
        },
      },
    },
  });
  const ledgerChurns = async () =>
    (await db.select().from(billingEvents).where(eq(billingEvents.kind, "churn"))).length;
  const churnCountBefore = await ledgerChurns();

  // (a) the realistic order of lookups after a purge: only the customer id, which no longer
  // resolves to an account.
  const replay = await postStripe(signedStripe(deletedEvent("evt_smoke_deleted_after_purge", false)));
  check("the late customer.subscription.deleted is accepted", replay.status === 200, String(replay.status));
  check("…and books nothing (no second churn)", (await ledgerChurns()) === churnCountBefore);
  const replayed = await mrrReconciliation();
  check("…so ledger and live MRR still agree", replayed.driftCents === baseline.driftCents && replayed.ledgerCents === baseline.ledgerCents, JSON.stringify({ baseline, replayed }));
  const unattributed = await db.select().from(billingEvents).where(and(isNull(billingEvents.userId), eq(billingEvents.eventId, "evt_smoke_deleted_after_purge")));
  check("…and left no ledger row of its own", unattributed.length === 0);

  // (b) the same event carrying the checkout's `orbit_user_id` hint, which real subscription
  // events do. The ledger must still be untouched; a hinted event also reaches the mirror
  // writer, which (outside this file's remit) may re-create a bare settings row — reported in
  // the handoff, so clean it up here rather than assert on it.
  const hinted = await postStripe(signedStripe(deletedEvent("evt_smoke_deleted_hinted", true)));
  check("a hinted late deleted event is accepted", hinted.status === 200, String(hinted.status));
  check("…and still books nothing", (await ledgerChurns()) === churnCountBefore);
  check("…and does not move the ledger", (await mrrReconciliation()).ledgerCents === baseline.ledgerCents);
  await db.delete(userSettings).where(eq(userSettings.userId, SUBSCRIBER));

  console.log("\nA retry, a race, a lapsed plan and a broken ledger");
  // A second deletion pass for the same subscriber is a no-op on the unique key.
  await seedSubscriber(SUBSCRIBER);
  await deleteOwnAccount(SUBSCRIBER, fakeDeps());
  check(
    "re-deleting the same account/customer never books a second churn",
    (await churnRows()).filter((r) => r.eventId.startsWith(`del:${SUBSCRIBER}:`)).length === 1
  );

  // The Stripe `deleted` webhook beat us to it: the ledger already holds 0 for the account,
  // so booking the raw subscription value would push the ledger BELOW the truth.
  await seedSubscriber(RACED);
  await recordBillingEventStrict({
    source: "stripe",
    eventId: "evt_raced_churn",
    kind: "churn",
    userId: RACED,
    mrrDeltaCents: -899,
    effectiveAt: new Date(),
  });
  await deleteOwnAccount(RACED, fakeDeps());
  check(
    "when the webhook already booked the churn, deletion books none (capped by the ledger)",
    (await churnRows()).filter((r) => r.eventId.startsWith(`del:${RACED}:`)).length === 0
  );

  // Canceled and already lapsed: worth 0, nothing to take out.
  await seedSubscriber(LAPSED, { status: "canceled", periodEnd: past, ledger: false });
  await deleteOwnAccount(LAPSED, fakeDeps());
  check(
    "a canceled, lapsed subscription books nothing",
    (await churnRows()).filter((r) => r.eventId.startsWith(`del:${LAPSED}:`)).length === 0
  );

  // Booking failure must never block the deletion: a trigger makes ONLY the churn insert
  // throw (the purge still has to anonymise `billing_events`, so the table itself stays).
  await seedSubscriber(BROKEN_LEDGER);
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION smoke_refuse_deletion_churn() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'smoke: ledger refuses the deletion churn'; END;
    $$ LANGUAGE plpgsql
  `);
  await db.execute(sql`
    CREATE TRIGGER smoke_refuse_deletion_churn BEFORE INSERT ON billing_events
    FOR EACH ROW WHEN (NEW.event_id LIKE 'del:%') EXECUTE FUNCTION smoke_refuse_deletion_churn()
  `);
  let threw: unknown = null;
  try {
    await deleteOwnAccount(BROKEN_LEDGER, fakeDeps());
  } catch (err) {
    threw = err;
  } finally {
    await db.execute(sql`DROP TRIGGER smoke_refuse_deletion_churn ON billing_events`);
    await db.execute(sql`DROP FUNCTION smoke_refuse_deletion_churn()`);
  }
  check("a ledger that cannot be written does not stop the deletion", threw === null, String(threw));
  check("…the account is deleted anyway", (await settingsRows(BROKEN_LEDGER)).length === 0);

  await cleanBilling();
  await db.delete(productEvents).where(eq(productEvents.name, "account_deleted"));

  await cleanup();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll account-deletion checks passed.");
});
