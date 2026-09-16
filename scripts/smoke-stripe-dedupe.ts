/**
 * Stripe webhook dedupe and the bookings-before-mirror order (launch Phase 2, audit B2).
 *
 *   - A handled event id is recorded once; a redelivery answers 200 and changes nothing.
 *   - An ignored event is NOT recorded, so a retry after the cause is fixed still applies.
 *   - A booking that cannot be written leaves the mirror untouched, so the retry computes
 *     the same "before" and books exactly once.
 *
 * Run: npx tsx scripts/smoke-stripe-dedupe.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

const TEST_SECRET = "whsec_test_smoke_dedupe_only";
process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
process.env.STRIPE_SECRET_KEY ||= "sk_test_smoke_only_not_a_real_key";

import Stripe from "stripe";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  billingEvents,
  stripeProcessedEvents,
  userSettings,
  webhookDeliveries,
} from "../src/db/schema";
import { POST } from "../src/app/api/webhooks/stripe/route";
import { decideStripeEvent } from "../src/lib/billing-stripe";
import {
  applyStripeDecision,
  defaultStripeApplyDeps,
  readDecideContext,
} from "../src/lib/stripe-fulfilment";
import { ensureUserSettings } from "../src/lib/user-settings";
import {
  LIFETIME_METADATA_KEY,
  PRO_METADATA_VALUE,
  SUBSCRIPTION_USER_METADATA_KEY,
} from "../src/lib/stripe";

const USER = "smoke-dedupe-user";
const TEAR_USER = "smoke-dedupe-tear-user";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function signed(event: unknown) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_SECRET });
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

const post = (req: Request) => POST(req as unknown as Parameters<typeof POST>[0]);

let seq = 0;
function subEvent(
  type: string,
  userId: string,
  over: Record<string, unknown> = {},
  created?: number
) {
  seq += 1;
  return {
    id: `evt_smoke_dedupe_${seq}`,
    object: "event",
    type,
    ...(created !== undefined ? { created } : {}),
    data: {
      object: {
        id: `sub_${userId}`,
        object: "subscription",
        status: "active",
        customer: `cus_${userId}`,
        metadata: {
          [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE,
          [SUBSCRIPTION_USER_METADATA_KEY]: userId,
        },
        items: {
          data: [
            {
              id: `si_${userId}`,
              quantity: 1,
              current_period_end: Math.floor(Date.now() / 1000) + 20 * 86400,
              price: { id: "price_smoke", unit_amount: 500, recurring: { interval: "month", interval_count: 1 } },
            },
          ],
        },
        ...over,
      },
    },
  };
}

async function settingsFor(userId: string) {
  const db = await getDb();
  return db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
}

async function ledgerFor(userId: string) {
  const db = await getDb();
  return db.select().from(billingEvents).where(eq(billingEvents.userId, userId));
}

async function lastDelivery() {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.source, "stripe"))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(1);
  return row;
}

async function reset() {
  const db = await getDb();
  for (const u of [USER, TEAR_USER]) {
    await db.delete(billingEvents).where(eq(billingEvents.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
    await ensureUserSettings(u);
  }
  await db.delete(stripeProcessedEvents);
  await db.delete(webhookDeliveries).where(eq(webhookDeliveries.source, "stripe"));
}

async function main() {
  await reset();
  const db = await getDb();

  console.log("A handled event is applied once");
  const first = subEvent("customer.subscription.updated", USER);
  check("first delivery -> 200", (await post(signed(first))).status === 200);
  check("the plan was granted", (await settingsFor(USER))?.subscriptionStatus === "active");
  const processed = await db
    .select()
    .from(stripeProcessedEvents)
    .where(eq(stripeProcessedEvents.eventId, first.id));
  check("the event id was recorded as processed", processed.length === 1);
  const ledgerAfterFirst = (await ledgerFor(USER)).length;
  check("the new subscription booked one movement", ledgerAfterFirst === 1, String(ledgerAfterFirst));

  // Cancel in between, so a re-applied first event WOULD visibly re-grant.
  await post(signed(subEvent("customer.subscription.deleted", USER, { status: "canceled" })));
  check("the cancellation applied", (await settingsFor(USER))?.subscriptionStatus === "canceled");

  const again = await post(signed(first));
  check("a redelivery of a handled event -> 200", again.status === 200);
  check("...and does not re-grant", (await settingsFor(USER))?.subscriptionStatus === "canceled");
  const dup = await lastDelivery();
  check("...recorded as ignored / duplicate_event", dup?.outcome === "ignored" && dup?.reason === "duplicate_event", JSON.stringify(dup));

  console.log("\nAn ignored event stays retryable");
  const other = subEvent("customer.subscription.updated", USER, {
    metadata: { [LIFETIME_METADATA_KEY]: "something-else", [SUBSCRIPTION_USER_METADATA_KEY]: USER },
  });
  await post(signed(other));
  const otherProcessed = await db
    .select()
    .from(stripeProcessedEvents)
    .where(eq(stripeProcessedEvents.eventId, other.id));
  check("an ignored event is not recorded as processed", otherProcessed.length === 0);

  console.log("\nA booking that cannot be written leaves the mirror alone");
  const tearEvent = subEvent("customer.subscription.updated", TEAR_USER) as unknown as Stripe.Event;
  const ctx1 = await readDecideContext(tearEvent, new Date());
  const decision1 = decideStripeEvent(tearEvent, ctx1);
  check("the decision books a movement and writes a mirror", decision1.bookings.length === 1 && decision1.mirror !== null);
  let threw = false;
  try {
    await applyStripeDecision(decision1, {
      ...defaultStripeApplyDeps,
      book: async () => {
        throw new Error("ledger unavailable");
      },
    });
  } catch {
    threw = true;
  }
  check("the apply throws (so the webhook answers 500 and Stripe retries)", threw);
  check("the mirror was not written", (await settingsFor(TEAR_USER))?.subscriptionPlan === null);

  const ctx2 = await readDecideContext(tearEvent, new Date());
  check("the retry sees the same 'before'", ctx2.beforeCents === ctx1.beforeCents, `${ctx1.beforeCents} vs ${ctx2.beforeCents}`);
  await applyStripeDecision(decideStripeEvent(tearEvent, ctx2));
  const tearLedger = await ledgerFor(TEAR_USER);
  check("the retry books exactly one movement", tearLedger.length === 1 && tearLedger[0]?.mrrDeltaCents === 500, JSON.stringify(tearLedger.map((r) => r.mrrDeltaCents)));
  check("...and then writes the mirror", (await settingsFor(TEAR_USER))?.subscriptionStatus === "active");

  await reset();
  console.log("\nAll Stripe dedupe checks passed.");
}

run(main);
