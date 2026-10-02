import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { recordAdminAction } from "@/lib/admin-operations";
import { resolvePlan } from "@/lib/entitlements";
import type { Plan } from "@/lib/plans/plan-config";
import {
  endSubscriptionForLifetime,
  lifetimeGrantSubscriptionEffect,
  type LifetimeSubscriptionEffect,
  type SubscriptionStripe,
} from "@/lib/subscription-management";
import { revokeLifetimePurchase, setCompedPlan } from "@/lib/user-settings";

/**
 * Orbit Lifetime is admin-assigned only (pricing v2): never sold, granted and revoked from the
 * console. Lifetime = every Max entitlement, with AI on the account's own key only.
 *
 * The bodies of `grantLifetimeAction` / `revokeLifetimeAction` / `previewLifetimeAction` in
 * `src/actions/admin.ts`, which add only the admin check — so a smoke can drive them without
 * a Clerk request context. `deps.stripe` stands in for Stripe the same way.
 */
export type LifetimePreview = {
  email: string | null;
  plan: Plan;
  compedLifetime: boolean;
  /** A Lifetime bought before pricing v2 (revoking it needs an explicit second confirmation). */
  purchasedLifetime: boolean;
  subscription: LifetimeSubscriptionEffect | { kind: "error"; error: string };
};

type Deps = { stripe?: SubscriptionStripe };

export async function previewLifetime(targetUserId: string, deps: Deps = {}): Promise<LifetimePreview> {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, targetUserId) });
  if (!row) throw new Error("No such account.");
  return {
    email: row.email ?? null,
    plan: resolvePlan(row).plan,
    compedLifetime: row.compedPlan === "lifetime",
    purchasedLifetime: Boolean(row.lifetimePurchasedAt),
    subscription: await lifetimeGrantSubscriptionEffect(targetUserId, deps),
  };
}

/**
 * One plan at a time: a live subscription is set to end at the close of the period already
 * paid for — no refund, no proration, no further charge. The audit row records what
 * happened to it, including a Stripe failure the admin then has to fix by hand.
 */
export async function grantLifetime(
  adminUserId: string,
  input: { targetUserId: string; reason: string },
  deps: Deps = {}
): Promise<{ ok: true; subscription: "scheduled" | "none" | "error" }> {
  const reason = input.reason.trim() || "Granted from the admin console";
  const db = await getDb();
  const before = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, input.targetUserId) });
  if (!before) throw new Error("No such account.");
  const fromPlan = resolvePlan(before).plan;

  await setCompedPlan(input.targetUserId, "lifetime", { note: reason, adminUserId });
  const subscription = await endSubscriptionForLifetime(input.targetUserId, deps);

  await recordAdminAction({
    adminUserId,
    action: "lifetime.grant",
    targetUserId: input.targetUserId,
    detail: { from: fromPlan, previousComp: before.compedPlan ?? null, subscription },
    reason,
  });
  return { ok: true, subscription };
}

/**
 * A comped Lifetime is removed; a PURCHASED one (bought before pricing v2) only when
 * `includePurchase` says so — that is money someone paid. The account falls back to its real
 * billing state; a subscription the grant set to end is not restarted.
 */
export async function revokeLifetime(
  adminUserId: string,
  input: { targetUserId: string; reason: string; includePurchase?: boolean }
): Promise<{ ok: true; plan: Plan }> {
  const reason = input.reason.trim() || "Revoked from the admin console";
  const db = await getDb();
  const before = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, input.targetUserId),
    columns: { compedPlan: true, lifetimePurchasedAt: true },
  });
  if (!before) throw new Error("No such account.");
  if (before.compedPlan !== "lifetime" && !(input.includePurchase && before.lifetimePurchasedAt)) {
    throw new Error("This account has no Lifetime to revoke.");
  }

  if (before.compedPlan === "lifetime") {
    await setCompedPlan(input.targetUserId, null, { note: reason, adminUserId });
  }
  const purchaseRevoked = input.includePurchase ? await revokeLifetimePurchase(input.targetUserId) : false;

  await recordAdminAction({
    adminUserId,
    action: "lifetime.revoke",
    targetUserId: input.targetUserId,
    detail: { compRemoved: before.compedPlan === "lifetime", purchaseRevoked },
    reason,
  });
  const after = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, input.targetUserId) });
  return { ok: true, plan: resolvePlan(after).plan };
}
