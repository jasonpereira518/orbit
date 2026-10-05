/**
 * Orbit Lifetime is granted and revoked by an admin only (pricing v2):
 *
 *  - The preview tells the admin what will happen first, including the date a live
 *    subscription will end.
 *  - Granting to a subscriber sets the subscription to end at its period end (never now,
 *    never refunded), and both actions land in the audit log.
 *  - Revoking a PURCHASED Lifetime needs an explicit second confirmation.
 *  - Lifetime is Max without managed AI, and granting it queues the upgrade celebration.
 *
 * Stripe is a fake; every call is recorded. Run: npx tsx scripts/smoke-admin-lifetime.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import type Stripe from "stripe";

const ADMIN = "smoke-al-admin";
const FREE = "smoke-al-free";
const SUBSCRIBER = "smoke-al-subscriber";
const BUYER = "smoke-al-buyer";
const PERIOD_END = Math.floor(Date.now() / 1000) + 12 * 86_400;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

function fakeStripe() {
  const sub = {
    id: "sub_al", object: "subscription", status: "active", created: 1, cancel_at_period_end: false, cancel_at: null,
    metadata: { orbit_plan: "orbit" }, customer: "cus_al",
    items: { data: [{ id: "si_al", quantity: 1, current_period_end: PERIOD_END,
      price: { id: "price_pro", lookup_key: "orbit_pro_monthly_v2", unit_amount: 899, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
  } as unknown as Stripe.Subscription;
  const updates: Array<{ id: string; params: Stripe.SubscriptionUpdateParams }> = [];
  return {
    updates,
    stripe: {
      list: async () => [sub],
      update: async (id: string, params: Stripe.SubscriptionUpdateParams) => {
        updates.push({ id, params });
        return { ...sub, cancel_at_period_end: true } as Stripe.Subscription;
      },
      portal: async () => ({ url: null }),
      priceFor: async () => "price_x",
      portalConfiguration: async () => undefined,
    },
  };
}

run(async () => {
  const { and, eq, inArray } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const { adminAuditLog, planUpgradeEvents, userSettings } = await import("../src/db/schema");
  const { grantLifetime, previewLifetime, revokeLifetime } = await import("../src/lib/admin-lifetime");
  const { getEntitlements } = await import("../src/lib/entitlements");

  const db = await getDb();
  const users = [FREE, SUBSCRIBER, BUYER];
  const reset = async () => {
    await db.delete(adminAuditLog).where(inArray(adminAuditLog.targetUserId, users));
    await db.delete(planUpgradeEvents).where(inArray(planUpgradeEvents.userId, users));
    await db.delete(userSettings).where(inArray(userSettings.userId, users));
  };
  await reset();
  await db.insert(userSettings).values([
    { userId: FREE, email: "free@example.test" },
    { userId: SUBSCRIBER, stripeCustomerId: "cus_al", subscriptionPlan: "orbit", subscriptionStatus: "active" },
    { userId: BUYER, lifetimePurchasedAt: new Date("2026-05-01") },
  ]);
  const audit = async (userId: string, action: string) =>
    db.select().from(adminAuditLog).where(and(eq(adminAuditLog.targetUserId, userId), eq(adminAuditLog.action, action)));

  console.log("Granting Lifetime to a Free account");
  const freePreview = await previewLifetime(FREE, { stripe: fakeStripe().stripe });
  check("the preview says nothing changes in Stripe", freePreview.subscription.kind === "none" && freePreview.plan === "free", freePreview);
  const g1 = await grantLifetime(ADMIN, { targetUserId: FREE, reason: "early supporter" }, { stripe: fakeStripe().stripe });
  check("granted, with no subscription to end", g1.subscription === "none");
  const ent = await getEntitlements(FREE);
  check("the account is Lifetime: Max features, API included", ent.plan === "lifetime" && ent.canUseApi && ent.contactLimit === null);
  check("…with AI on its own key only — no credits, no packs", !ent.canUseHostedAi && !ent.canBuyCreditPacks);
  const [grantRow] = await audit(FREE, "lifetime.grant");
  check("the grant is in the audit log, with the reason", grantRow?.adminUserId === ADMIN && grantRow.reason === "early supporter" &&
    (grantRow.detail as { from?: string })?.from === "free", grantRow);
  const [celebrate] = await db.select().from(planUpgradeEvents).where(eq(planUpgradeEvents.userId, FREE));
  check("…and the upgrade celebration is queued for Lifetime", celebrate?.plan === "lifetime", celebrate);

  console.log("\nGranting Lifetime to a Pro subscriber");
  const fake = fakeStripe();
  const subPreview = await previewLifetime(SUBSCRIBER, { stripe: fake.stripe });
  check("the preview shows the subscription ending at its period end, with the date",
    subPreview.subscription.kind === "ends_at_period_end" && subPreview.subscription.periodEnd === PERIOD_END &&
      subPreview.subscription.plan === "orbit", subPreview.subscription);
  check("…and previewing changes nothing", fake.updates.length === 0);
  const g2 = await grantLifetime(ADMIN, { targetUserId: SUBSCRIBER, reason: "" }, { stripe: fake.stripe });
  check("granting sets cancel_at_period_end — never an immediate cancel",
    g2.subscription === "scheduled" && fake.updates.length === 1 && fake.updates[0].params.cancel_at_period_end === true &&
      Object.keys(fake.updates[0].params).length === 1, fake.updates);
  check("the subscriber is on Lifetime while the paid period runs out", (await getEntitlements(SUBSCRIBER)).plan === "lifetime");
  const [subGrant] = await audit(SUBSCRIBER, "lifetime.grant");
  check("the audit row records what happened to the subscription and a default reason",
    (subGrant?.detail as { subscription?: string })?.subscription === "scheduled" && Boolean(subGrant?.reason), subGrant);

  console.log("\nRevoking");
  const r1 = await revokeLifetime(ADMIN, { targetUserId: FREE, reason: "test over" });
  check("a comped Lifetime is removed; the account falls back to Free", r1.plan === "free");
  check("…and the revoke is in the audit log", (await audit(FREE, "lifetime.revoke")).length === 1);
  let refused: unknown = null;
  try {
    await revokeLifetime(ADMIN, { targetUserId: BUYER, reason: "x" });
  } catch (err) {
    refused = err;
  }
  check("a PURCHASED Lifetime is not revoked without the explicit second confirmation", refused instanceof Error &&
    (await getEntitlements(BUYER)).plan === "lifetime");
  const r2 = await revokeLifetime(ADMIN, { targetUserId: BUYER, reason: "chargeback settled", includePurchase: true });
  check("…and is with it", r2.plan === "free" &&
    ((await audit(BUYER, "lifetime.revoke"))[0]?.detail as { purchaseRevoked?: boolean })?.purchaseRevoked === true);
  let none: unknown = null;
  try {
    await revokeLifetime(ADMIN, { targetUserId: FREE, reason: "again" });
  } catch (err) {
    none = err;
  }
  check("revoking an account with no Lifetime is refused", none instanceof Error);

  await reset();
  if (failures > 0) throw new Error(`${failures} admin-lifetime check(s) failed`);
  console.log("\nAll admin-lifetime checks passed.");
});
