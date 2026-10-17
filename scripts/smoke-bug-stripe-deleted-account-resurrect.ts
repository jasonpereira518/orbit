/**
 * KNOWN BUG — documented, not fixed.
 *
 * Symptom: deleting your account from Settings removes the `user_settings` row, and the
 * Stripe webhook that the deletion itself causes puts it straight back — with the deleted
 * user's id, their Stripe customer id and a canceled Pro subscription mirrored on it.
 *
 * Why: `deleteOwnAccount` (src/lib/account-deletion.ts:62-98) cancels the live subscription
 * FIRST (`stripe.subscriptions.cancel`, :43) and then purges everything, settings row included.
 * Stripe answers the cancel with `customer.subscription.deleted`, delivered asynchronously —
 * i.e. after the purge. `attributeStripeEvent` (src/lib/stripe-fulfilment.ts:49) takes the
 * user id from the subscription's own `orbit_user_id` metadata, with no check that the account
 * still exists; `setSubscriptionState` (src/lib/user-settings.ts:246) begins with
 * `ensureUserSettings` (:34), which INSERTs a fresh row when none is found.
 *
 * Trigger path: any paying subscriber who deletes their account. The resurrected row has a
 * fresh `last_active_at`, so the Clerk orphan sweep (src/lib/clerk-orphan-sweep.ts, 7 days of
 * inactivity) only removes it a week or more later; until then the deleted user appears in
 * the admin roster and export with their Stripe customer id.
 *
 * Severity: low — no access is granted (Clerk login is gone) and it self-heals after the
 * orphan sweep, but it contradicts "every table, the settings row … included" and keeps a
 * deleted person's billing link around.
 *
 * Fix: make the webhook refuse to create an account it can only attribute by a hint (e.g. use
 * an update-only mirror write for subscription events, or check a deletion tombstone). This
 * script then exits 0 and should be promoted to the pglite tier.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-bug-stripe-deleted-account-resurrect.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { stripeProcessedEvents, userSettings } from "../src/db/schema";
import { deleteOwnAccount } from "../src/lib/account-deletion";
import { LIFETIME_METADATA_KEY, PRO_METADATA_VALUE, SUBSCRIPTION_USER_METADATA_KEY } from "../src/lib/stripe-config";
import { processStripeEvent } from "../src/lib/stripe-event-processor";
import { ensureUserSettings } from "../src/lib/user-settings";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, purgeUsers } from "./smoke/factories";

const t = checker();
const USER = fakeUserId("deleted-resurrect");
const CUSTOMER = `cus_${USER}`;
const NOW = new Date();
const NOW_S = Math.floor(NOW.getTime() / 1000);
const EVENT_ID = `evt_${USER}_deleted`;

run(async () => {
  const db = await getDb();
  await purgeUsers(db, [USER]);

  try {
    await ensureUserSettings(USER);
    await db
      .update(userSettings)
      .set({
        stripeCustomerId: CUSTOMER,
        subscriptionPlan: "orbit",
        subscriptionStatus: "active",
        subscriptionPeriodEnd: new Date((NOW_S + 20 * 86_400) * 1000),
        email: "ada.lovelace@example.com",
      })
      .where(eq(userSettings.userId, USER));
    await insertContact(db, USER, 0);

    const cancelled: string[] = [];
    await deleteOwnAccount(USER, {
      cancelSubscriptions: async (customerId) => void cancelled.push(customerId),
      deleteLogin: async () => {},
    });
    t.check("setup: deletion cancelled the Stripe subscription first", cancelled[0] === CUSTOMER);
    const afterDelete = await db.select().from(userSettings).where(eq(userSettings.userId, USER));
    t.check("setup: the settings row is gone after the purge", afterDelete.length === 0);

    // What Stripe sends in answer to that cancel, arriving after the purge.
    const deleted = {
      id: EVENT_ID,
      object: "event",
      type: "customer.subscription.deleted",
      created: NOW_S,
      data: {
        object: {
          id: `sub_${USER}`,
          object: "subscription",
          status: "canceled",
          customer: CUSTOMER,
          metadata: { [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE, [SUBSCRIPTION_USER_METADATA_KEY]: USER },
          items: {
            data: [{
              id: "si_1",
              quantity: 1,
              current_period_start: NOW_S - 10 * 86_400,
              current_period_end: NOW_S + 20 * 86_400,
              price: { unit_amount: 500, recurring: { interval: "month", interval_count: 1 } },
            }],
          },
        },
      },
    } as unknown as Stripe.Event;
    const result = await processStripeEvent(deleted, { now: NOW, updateSubscription: async () => ({}) });
    t.check("the webhook processes without throwing", !result.duplicate);

    const resurrected = await db.select().from(userSettings).where(eq(userSettings.userId, USER));
    t.knownBug(
      "BUG: customer.subscription.deleted after account deletion re-creates the deleted user's user_settings row",
      resurrected.length === 0,
      resurrected.length
        ? `row back with stripe_customer_id=${resurrected[0].stripeCustomerId}, status=${resurrected[0].subscriptionStatus}, plan=${resurrected[0].subscriptionPlan}`
        : ""
    );
  } finally {
    await purgeUsers(db, [USER]);
    await db.delete(stripeProcessedEvents).where(eq(stripeProcessedEvents.eventId, EVENT_ID));
  }

  t.done("deleted account resurrected by Stripe webhook (known bug)");
});
