/**
 * A Pro subscriber can cancel, undo it, and switch monthly ↔ annual from the plan card — on
 * their own subscription only — and a Lifetime purchase cancels Pro on the spot (one plan at a time).
 *
 * Stripe is a fake: every call is recorded, so the checks read what would have been sent.
 *
 * Run: npx tsx scripts/smoke-subscription-management.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

// Read at module load by src/lib/stripe.ts, so set before the dynamic imports below.
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_smoke_monthly";
process.env.STRIPE_PRO_ANNUAL_PRICE_ID = "price_smoke_annual";

import type Stripe from "stripe";

const SUBSCRIBER = "smoke-subman-subscriber";
const LIFETIME = "smoke-subman-lifetime";
const FREE = "smoke-subman-free";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const PERIOD_END = Math.floor(Date.now() / 1000) + 20 * 86_400;

function fakeSub(over: Partial<Stripe.Subscription> & { price?: string; interval?: "month" | "year"; amount?: number } = {}) {
  const { price = "price_smoke_monthly", interval = "month", amount = 500, ...rest } = over;
  return {
    id: "sub_smoke",
    object: "subscription",
    status: "active",
    created: 100,
    cancel_at_period_end: false,
    cancel_at: null,
    metadata: { orbit_plan: "orbit" },
    customer: "cus_smoke_sub",
    items: {
      data: [
        {
          id: "si_smoke",
          quantity: 1,
          current_period_end: PERIOD_END,
          price: { id: price, unit_amount: amount, currency: "usd", recurring: { interval, interval_count: 1 } },
        },
      ],
    },
    ...rest,
  } as unknown as Stripe.Subscription;
}

function fakeStripe(subs: Stripe.Subscription[]) {
  const calls = {
    list: [] as string[],
    update: [] as Array<{ id: string; params: Stripe.SubscriptionUpdateParams }>,
    preview: [] as Stripe.InvoiceCreatePreviewParams[],
    cancel: [] as Array<{ id: string; params: Stripe.SubscriptionCancelParams }>,
  };
  const state = { subs: [...subs], previewTotal: 4520, updateError: null as unknown };
  return {
    calls,
    state,
    stripe: {
      list: async (customer: string) => {
        calls.list.push(customer);
        return state.subs;
      },
      update: async (id: string, params: Stripe.SubscriptionUpdateParams) => {
        calls.update.push({ id, params });
        if (state.updateError) throw state.updateError;
        const current = state.subs.find((s) => s.id === id)!;
        const next = { ...current } as Stripe.Subscription;
        if (params.cancel_at_period_end !== undefined) next.cancel_at_period_end = params.cancel_at_period_end;
        if (params.cancel_at === "") next.cancel_at = null;
        if (params.items?.[0]?.price) {
          const annual = params.items[0].price === "price_smoke_annual";
          Object.assign(next, {
            items: fakeSub({ price: params.items[0].price, interval: annual ? "year" : "month", amount: annual ? 5000 : 500 }).items,
          });
        }
        state.subs = state.subs.map((s) => (s.id === id ? next : s));
        return next;
      },
      preview: async (params: Stripe.InvoiceCreatePreviewParams) => {
        calls.preview.push(params);
        return { total: state.previewTotal, currency: "usd" };
      },
      cancel: async (id: string, params: Stripe.SubscriptionCancelParams) => {
        calls.cancel.push({ id, params });
        if (state.updateError) throw state.updateError;
        state.subs = state.subs.map((s) => (s.id === id ? ({ ...s, status: "canceled" } as Stripe.Subscription) : s));
        return {};
      },
    },
  };
}

run(async () => {
  const { eq } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const { userSettings } = await import("../src/db/schema");
  const { ensureUserSettings } = await import("../src/lib/user-settings");
  const sm = await import("../src/lib/subscription-management");

  const db = await getDb();
  for (const id of [SUBSCRIBER, LIFETIME, FREE]) await ensureUserSettings(id);
  await db.update(userSettings)
    .set({ stripeCustomerId: "cus_smoke_sub", subscriptionPlan: "orbit", subscriptionStatus: "active", subscriptionPeriodEnd: new Date(PERIOD_END * 1000) })
    .where(eq(userSettings.userId, SUBSCRIBER));
  await db.update(userSettings)
    .set({ stripeCustomerId: "cus_smoke_life", lifetimePurchasedAt: new Date() })
    .where(eq(userSettings.userId, LIFETIME));

  console.log("The subscriber sees their own subscription");
  {
    const other = fakeSub({ id: "sub_other_product", created: 999, metadata: { orbit_plan: "something_else" } } as never);
    const ended = fakeSub({ id: "sub_old", created: 50, status: "canceled" } as never);
    const f = fakeStripe([ended, other, fakeSub()]);
    const res = await sm.getSubscriptionDetails(SUBSCRIBER, { stripe: f.stripe });
    check("looked up through their own customer id", f.calls.list[0] === "cus_smoke_sub", f.calls.list.join());
    check("picked the live Pro subscription, not another product's or an ended one",
      res.ok && res.subscription.period === "monthly" && res.subscription.amountCents === 500, JSON.stringify(res));
    check("renewal date is the period end", res.ok && res.subscription.periodEnd === PERIOD_END);
  }

  console.log("\nNobody else reaches Stripe");
  {
    const f = fakeStripe([fakeSub()]);
    for (const [who, id] of [["Lifetime", LIFETIME], ["Free", FREE]] as const) {
      const r1 = await sm.cancelSubscription(id, { stripe: f.stripe });
      const r2 = await sm.changeBillingPeriod(id, "annual", { stripe: f.stripe });
      check(`a ${who} account is told there is nothing to manage`,
        !r1.ok && r1.error === sm.SUBSCRIPTION_COPY.noSubscription && !r2.ok, JSON.stringify([r1, r2]));
    }
    check("neither listed nor updated anything", f.calls.list.length === 0 && f.calls.update.length === 0);
  }

  console.log("\nCancel, then undo");
  {
    const f = fakeStripe([fakeSub()]);
    const canceled = await sm.cancelSubscription(SUBSCRIBER, { stripe: f.stripe });
    check("cancels at period end, never immediately",
      f.calls.update[0]?.params.cancel_at_period_end === true && Object.keys(f.calls.update[0].params).length === 1,
      JSON.stringify(f.calls.update[0]));
    check("reports the pending cancellation", canceled.ok && canceled.subscription.cancelAtPeriodEnd);
    const again = await sm.cancelSubscription(SUBSCRIBER, { stripe: f.stripe });
    check("canceling twice is a no-op", again.ok && f.calls.update.length === 1);

    const blocked = await sm.changeBillingPeriod(SUBSCRIBER, "annual", { stripe: f.stripe });
    check("a pending cancellation blocks a billing switch",
      !blocked.ok && blocked.error === sm.SUBSCRIPTION_COPY.cancelPending, JSON.stringify(blocked));

    const resumed = await sm.resumeSubscription(SUBSCRIBER, { stripe: f.stripe });
    check("resume clears the flag and any cancel date",
      f.calls.update[1]?.params.cancel_at_period_end === false && f.calls.update[1]?.params.cancel_at === "",
      JSON.stringify(f.calls.update[1]));
    check("reports it renewing again", resumed.ok && !resumed.subscription.cancelAtPeriodEnd);

    const dated = fakeStripe([fakeSub({ cancel_at: PERIOD_END - 86_400 } as never)]);
    const d = await sm.getSubscriptionDetails(SUBSCRIBER, { stripe: dated.stripe });
    check("a dashboard-set cancel date reads as pending, ending on that date",
      d.ok && d.subscription.cancelAtPeriodEnd && d.subscription.periodEnd === PERIOD_END - 86_400, JSON.stringify(d));
  }

  console.log("\nMonthly ↔ annual");
  {
    const f = fakeStripe([fakeSub()]);
    const preview = await sm.previewBillingPeriodChange(SUBSCRIBER, "annual", { stripe: f.stripe });
    check("preview quotes Stripe's own total", preview.ok && preview.totalCents === 4520, JSON.stringify(preview));
    const p = f.calls.preview[0];
    check("preview swaps the existing item to the annual price, invoiced now",
      p?.subscription === "sub_smoke" && p.subscription_details?.items?.[0]?.id === "si_smoke" &&
        p.subscription_details.items[0].price === "price_smoke_annual" &&
        p.subscription_details.proration_behavior === "always_invoice", JSON.stringify(p));

    const up = await sm.changeBillingPeriod(SUBSCRIBER, "annual", { stripe: f.stripe });
    const u = f.calls.update[0]?.params;
    check("the switch sends the same item swap", u?.items?.[0]?.id === "si_smoke" && u.items[0].price === "price_smoke_annual");
    check("a declined charge rejects the switch outright", u?.payment_behavior === "error_if_incomplete");
    check("keeps the period metadata in step", (u?.metadata as Record<string, string> | undefined)?.orbit_billing_period === "annual");
    check("reports annual", up.ok && up.subscription.period === "annual" && up.subscription.amountCents === 5000, JSON.stringify(up));

    const same = await sm.changeBillingPeriod(SUBSCRIBER, "annual", { stripe: f.stripe });
    check("switching to the period you are on is refused",
      !same.ok && same.error === sm.SUBSCRIPTION_COPY.alreadyOnPeriod && f.calls.update.length === 1);

    f.state.previewTotal = -3750;
    const downPreview = await sm.previewBillingPeriodChange(SUBSCRIBER, "monthly", { stripe: f.stripe });
    check("annual → monthly previews as credit", downPreview.ok && downPreview.totalCents === -3750);
    const down = await sm.changeBillingPeriod(SUBSCRIBER, "monthly", { stripe: f.stripe });
    check("and switches back", down.ok && down.subscription.period === "monthly");

    const bogus = await sm.changeBillingPeriod(SUBSCRIBER, "weekly" as never, { stripe: f.stripe });
    check("an unknown period never reaches Stripe", !bogus.ok && f.calls.update.length === 2);

    f.state.updateError = Object.assign(new Error("Your card was declined."), { code: "card_declined" });
    const declined = await sm.changeBillingPeriod(SUBSCRIBER, "annual", { stripe: f.stripe });
    check("a declined card says so", !declined.ok && declined.error === sm.SUBSCRIPTION_COPY.paymentDeclined, JSON.stringify(declined));
    f.state.updateError = new Error("socket hang up");
    const broken = await sm.cancelSubscription(SUBSCRIBER, { stripe: f.stripe });
    check("other Stripe trouble is a sentence, not a stack trace",
      !broken.ok && broken.error === sm.SUBSCRIPTION_COPY.unavailable);
  }

  console.log("\nLifetime replaces Pro");
  {
    const other = fakeSub({ id: "sub_other_product", metadata: { orbit_plan: "something_else" } } as never);
    const f = fakeStripe([other, fakeSub()]);
    const r = await sm.endProForLifetime(SUBSCRIBER, { stripe: f.stripe });
    check("cancels Pro immediately", r === "canceled" && f.calls.cancel.length === 1 && f.calls.cancel[0].id === "sub_smoke",
      JSON.stringify(f.calls.cancel));
    check("with no proration credit or final invoice",
      f.calls.cancel[0]?.params.prorate === false && f.calls.cancel[0]?.params.invoice_now === false);
    check("leaves another product's subscription alone", !f.calls.cancel.some((c) => c.id === "sub_other_product"));
    check("never schedules instead of canceling", f.calls.update.length === 0);
    check("idempotent: the webhook arriving second finds nothing",
      (await sm.endProForLifetime(SUBSCRIBER, { stripe: f.stripe })) === "none" && f.calls.cancel.length === 1);
    const pending = fakeStripe([fakeSub({ cancel_at_period_end: true } as never)]);
    await sm.endProForLifetime(SUBSCRIBER, { stripe: pending.stripe });
    check("a subscription already set to end is canceled now too", pending.calls.cancel.length === 1);
    check("an account with no Stripe customer is fine",
      (await sm.endProForLifetime(FREE, { stripe: fakeStripe([fakeSub()]).stripe })) === "none");
    const failing = fakeStripe([fakeSub()]);
    failing.state.updateError = new Error("boom");
    check("never throws: the Lifetime grant already landed",
      (await sm.endProForLifetime(SUBSCRIBER, { stripe: failing.stripe })) === "error");
  }

  console.log("\nOne plan at a time");
  {
    const { getEntitlements } = await import("../src/lib/entitlements");
    await db.update(userSettings).set({ lifetimePurchasedAt: new Date() }).where(eq(userSettings.userId, SUBSCRIBER));
    const ent = await getEntitlements(SUBSCRIBER);
    check("Lifetime plus a leftover live subscription resolves to Lifetime alone",
      ent.plan === "lifetime" && ent.source === "lifetime" && ent.canUseHostedEnrichment === false, JSON.stringify(ent));
    const f = fakeStripe([fakeSub()]);
    const r = await sm.cancelSubscription(SUBSCRIBER, { stripe: f.stripe });
    check("and the card no longer treats it as a subscription", !r.ok && f.calls.list.length === 0);
  }

  check("copy follows the house voice",
    Object.values(sm.SUBSCRIPTION_COPY).every((c) => !/failed|Could not|\.$|'/.test(c)));

  if (failures > 0) throw new Error(`${failures} subscription-management check(s) failed`);
  console.log("\nAll subscription-management checks passed.");
});
