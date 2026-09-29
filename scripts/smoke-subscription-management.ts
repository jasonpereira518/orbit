/**
 * A subscriber can cancel, undo it, and switch between Pro and Max (on Stripe's confirmation
 * page) from the plan card — on their own subscription only — and an admin's Lifetime grant
 * sets their subscription to end at the period end (one plan at a time).
 *
 * Stripe is a fake: every call is recorded, so the checks read what would have been sent.
 *
 * Run: npx tsx scripts/smoke-subscription-management.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

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
  const { price = "price_smoke_pro", interval = "month", amount = 899, ...rest } = over;
  const lookupKey = price === "price_smoke_max" ? "orbit_max_monthly_v2" : price === "price_smoke_pro" ? "orbit_pro_monthly_v2" : null;
  return {
    id: "sub_smoke",
    object: "subscription",
    status: "active",
    created: 100,
    cancel_at_period_end: false,
    cancel_at: null,
    metadata: { orbit_plan: "orbit" },
    customer: "cus_smoke_subman",
    items: {
      data: [
        {
          id: "si_smoke",
          quantity: 1,
          current_period_end: PERIOD_END,
          price: { id: price, lookup_key: lookupKey, unit_amount: amount, currency: "usd", recurring: { interval, interval_count: 1 } },
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
    portal: [] as Stripe.BillingPortal.SessionCreateParams[],
  };
  const state = { subs: [...subs], updateError: null as unknown };
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
        state.subs = state.subs.map((s) => (s.id === id ? next : s));
        return next;
      },
      portal: async (params: Stripe.BillingPortal.SessionCreateParams) => {
        calls.portal.push(params);
        if (state.updateError) throw state.updateError;
        return { url: "https://billing.stripe.test/session" };
      },
      priceFor: async (plan: "orbit" | "max") => (plan === "max" ? "price_smoke_max" : "price_smoke_pro"),
      portalConfiguration: async () => "bpc_smoke",
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
    .set({ stripeCustomerId: "cus_smoke_subman", subscriptionPlan: "orbit", subscriptionStatus: "active", subscriptionPeriodEnd: new Date(PERIOD_END * 1000) })
    .where(eq(userSettings.userId, SUBSCRIBER));
  await db.update(userSettings)
    .set({ stripeCustomerId: "cus_smoke_subman_life", lifetimePurchasedAt: new Date() })
    .where(eq(userSettings.userId, LIFETIME));

  console.log("The subscriber sees their own subscription");
  {
    const other = fakeSub({ id: "sub_other_product", created: 999, metadata: { orbit_plan: "something_else" } } as never);
    const ended = fakeSub({ id: "sub_old", created: 50, status: "canceled" } as never);
    const f = fakeStripe([ended, other, fakeSub()]);
    const res = await sm.getSubscriptionDetails(SUBSCRIBER, { stripe: f.stripe });
    check("looked up through their own customer id", f.calls.list[0] === "cus_smoke_subman", f.calls.list.join());
    check("picked the live Pro subscription, not another product's or an ended one",
      res.ok && res.subscription.period === "monthly" && res.subscription.plan === "orbit" && res.subscription.amountCents === 899, JSON.stringify(res));
    check("renewal date is the period end", res.ok && res.subscription.periodEnd === PERIOD_END);
  }

  console.log("\nNobody else reaches Stripe");
  {
    const f = fakeStripe([fakeSub()]);
    for (const [who, id] of [["Lifetime", LIFETIME], ["Free", FREE]] as const) {
      const r1 = await sm.cancelSubscription(id, { stripe: f.stripe });
      const r2 = await sm.createPlanSwitchUrl(id, "max", { stripe: f.stripe });
      check(`a ${who} account is told there is nothing to manage`,
        !r1.ok && r1.error === sm.SUBSCRIPTION_COPY.noSubscription && !r2.ok, JSON.stringify([r1, r2]));
    }
    check("neither listed, updated nor opened anything",
      f.calls.list.length === 0 && f.calls.update.length === 0 && f.calls.portal.length === 0);
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

    const blocked = await sm.createPlanSwitchUrl(SUBSCRIBER, "max", { stripe: f.stripe });
    check("a pending cancellation blocks a plan switch",
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

  console.log("\nPro ↔ Max");
  {
    const f = fakeStripe([fakeSub()]);
    const up = await sm.createPlanSwitchUrl(SUBSCRIBER, "max", { stripe: f.stripe });
    const session = f.calls.portal[0];
    check("returns Stripe's confirmation page", up.ok && up.url.startsWith("https://"), JSON.stringify(up));
    check("on their own customer, with the pricing v2 portal configuration",
      session?.customer === "cus_smoke_subman" && session.configuration === "bpc_smoke", JSON.stringify(session));
    const confirm = session?.flow_data?.subscription_update_confirm;
    check("a confirm flow that swaps the existing item to the Max price",
      session?.flow_data?.type === "subscription_update_confirm" && confirm?.subscription === "sub_smoke" &&
        confirm.items[0]?.id === "si_smoke" && confirm.items[0]?.price === "price_smoke_max", JSON.stringify(session?.flow_data));
    check("and comes back to Settings, arming the Max celebration",
      String(session?.flow_data?.after_completion?.redirect?.return_url ?? "").includes("upgraded=max"));
    check("never changes the subscription itself (Stripe does, after the person confirms)", f.calls.update.length === 0);

    const same = await sm.createPlanSwitchUrl(SUBSCRIBER, "orbit", { stripe: f.stripe });
    check("switching to the plan you are on is refused",
      !same.ok && same.error === sm.SUBSCRIPTION_COPY.alreadyOnPlan && f.calls.portal.length === 1);

    const onMax = fakeStripe([fakeSub({ price: "price_smoke_max", amount: 1999 })]);
    const down = await sm.createPlanSwitchUrl(SUBSCRIBER, "orbit", { stripe: onMax.stripe });
    check("Max → Pro offers the Pro price", down.ok &&
      onMax.calls.portal[0]?.flow_data?.subscription_update_confirm?.items[0]?.price === "price_smoke_pro");

    const legacy = fakeStripe([fakeSub({ price: "price_legacy_annual", interval: "year", amount: 5000 })]);
    const legacyDetails = await sm.getSubscriptionDetails(SUBSCRIBER, { stripe: legacy.stripe });
    check("a legacy $50/yr subscription reads as annual Pro, at its own price",
      legacyDetails.ok && legacyDetails.subscription.plan === "orbit" && legacyDetails.subscription.period === "annual" &&
        legacyDetails.subscription.amountCents === 5000, JSON.stringify(legacyDetails));

    const bogus = await sm.createPlanSwitchUrl(SUBSCRIBER, "lifetime" as never, { stripe: f.stripe });
    check("Lifetime is never a switch target", !bogus.ok && f.calls.portal.length === 1);

    f.state.updateError = new Error("socket hang up");
    const broken = await sm.cancelSubscription(SUBSCRIBER, { stripe: f.stripe });
    check("other Stripe trouble is a sentence, not a stack trace",
      !broken.ok && broken.error === sm.SUBSCRIPTION_COPY.unavailable);
  }

  console.log("\nAn admin's Lifetime grant ends the subscription at the period end");
  {
    const other = fakeSub({ id: "sub_other_product", metadata: { orbit_plan: "something_else" } } as never);
    const f = fakeStripe([other, fakeSub()]);
    const preview = await sm.lifetimeGrantSubscriptionEffect(SUBSCRIBER, { stripe: f.stripe });
    check("the admin is shown what will happen first",
      preview.kind === "ends_at_period_end" && preview.periodEnd === PERIOD_END && preview.plan === "orbit",
      JSON.stringify(preview));
    const r = await sm.endSubscriptionForLifetime(SUBSCRIBER, { stripe: f.stripe });
    check("sets cancel_at_period_end, never cancels now",
      r === "scheduled" && f.calls.update.length === 1 && f.calls.update[0].id === "sub_smoke" &&
        f.calls.update[0].params.cancel_at_period_end === true, JSON.stringify(f.calls.update));
    check("leaves another product's subscription alone", !f.calls.update.some((c) => c.id === "sub_other_product"));
    await sm.endSubscriptionForLifetime(SUBSCRIBER, { stripe: f.stripe });
    check("idempotent: a subscription already ending is left as it is", f.calls.update.length === 1);
    check("an account with no Stripe customer is fine",
      (await sm.endSubscriptionForLifetime(FREE, { stripe: fakeStripe([fakeSub()]).stripe })) === "none");
    check("and the preview says nothing will change",
      (await sm.lifetimeGrantSubscriptionEffect(FREE, { stripe: fakeStripe([fakeSub()]).stripe })).kind === "none");
    const failing = fakeStripe([fakeSub()]);
    failing.state.updateError = new Error("boom");
    check("never throws: the grant already landed",
      (await sm.endSubscriptionForLifetime(SUBSCRIBER, { stripe: failing.stripe })) === "error");
  }

  console.log("\nOne plan at a time");
  {
    const { getEntitlements } = await import("../src/lib/entitlements");
    await db.update(userSettings).set({ lifetimePurchasedAt: new Date() }).where(eq(userSettings.userId, SUBSCRIBER));
    const ent = await getEntitlements(SUBSCRIBER);
    check("Lifetime plus a leftover live subscription resolves to Lifetime alone",
      ent.plan === "lifetime" && ent.source === "lifetime" && ent.canUseHostedAi === false, JSON.stringify(ent));
    const f = fakeStripe([fakeSub()]);
    const r = await sm.cancelSubscription(SUBSCRIBER, { stripe: f.stripe });
    check("and the card no longer treats it as a subscription", !r.ok && f.calls.list.length === 0);
  }

  check("copy follows the house voice",
    Object.values(sm.SUBSCRIPTION_COPY).every((c) => !/failed|Could not|\.$|'/.test(c)));

  if (failures > 0) throw new Error(`${failures} subscription-management check(s) failed`);
  console.log("\nAll subscription-management checks passed.");
});
