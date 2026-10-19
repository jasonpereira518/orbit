/**
 * A deleted account stays deleted when Stripe answers the deletion's own cancel.
 *
 * `deleteOwnAccount` (src/lib/account-deletion.ts) cancels the live subscription FIRST and
 * then purges everything, settings row included. Stripe's `customer.subscription.deleted`
 * arrives asynchronously, after the purge, still naming the user in the subscription's
 * `orbit_user_id` metadata. Every mirror write begins with `ensureUserSettings`, which INSERTs
 * a row when none exists — so the webhook used to re-create the deleted user's
 * `user_settings` row with their Stripe customer id.
 *
 * Pinned fix: `applyStripeDecision` (src/lib/stripe-fulfilment.ts) asks `isDeletedAccount` —
 * no settings row AND a `keepSettings: false` purge recorded in `data_purge_runs` — and skips
 * the mirror for such an account (its bookings still land, anonymised). A brand-new account
 * with no row yet is not affected: it has no such purge.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-stripe-deleted-account-resurrect.ts
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
    t.check(
      "customer.subscription.deleted after account deletion does not re-create the deleted user's user_settings row",
      resurrected.length === 0,
      resurrected.length
        ? `row back with stripe_customer_id=${resurrected[0].stripeCustomerId}, status=${resurrected[0].subscriptionStatus}, plan=${resurrected[0].subscriptionPlan}`
        : ""
    );
  } finally {
    await purgeUsers(db, [USER]);
    await db.delete(stripeProcessedEvents).where(eq(stripeProcessedEvents.eventId, EVENT_ID));
  }

  t.done("deleted account not resurrected by Stripe webhook");
});
