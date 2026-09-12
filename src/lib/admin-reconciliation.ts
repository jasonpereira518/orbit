import { clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { recordAdminAction, requireReason } from "@/lib/admin-operations";
import { recordOperationalEvent } from "@/lib/operational-events";
import {
  getStripe,
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
} from "@/lib/stripe";
import {
  setLifetimePurchase,
  setSubscriptionState,
  setUserEmail,
  type SubscriptionMirror,
} from "@/lib/user-settings";

export type ReconciliationChange = {
  field: "email" | "subscriptionPlan" | "subscriptionStatus" | "subscriptionPeriodEnd";
  from: string | null;
  to: string | null;
};

export type ClerkReconciliationPreview = {
  targetUserId: string;
  canonicalEmail: string | null;
  mirror: SubscriptionMirror;
  changes: ReconciliationChange[];
};

function primaryEmail(user: {
  emailAddresses: Array<{ id: string; emailAddress: string }>;
  primaryEmailAddressId: string | null;
}): string | null {
  const primary =
    user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId) ??
    user.emailAddresses[0];
  return primary?.emailAddress.toLowerCase() ?? null;
}

async function clerkSubscription(userId: string) {
  const client = await clerkClient();
  try {
    return await client.billing.getUserBillingSubscription(userId);
  } catch (error) {
    const status = (error as { status?: number; statusCode?: number } | null)?.status ??
      (error as { statusCode?: number } | null)?.statusCode;
    if (status === 404) return null;
    throw error;
  }
}

/**
 * Always the empty mirror, deliberately.
 *
 * Clerk subscription reconciliation is inert: Orbit Pro is sold exclusively through Stripe,
 * the Clerk "orbit" plan has been removed from the Clerk Dashboard, and no Clerk
 * subscription was ever sold — see the note in `src/app/api/webhooks/clerk/route.ts`.
 * Reading a plan slug off Clerk would reconcile billing state against a product that does
 * not exist and could only ever clear a live Stripe mirror.
 *
 * The Clerk half of this module still earns its place for EMAIL: Clerk remains the source
 * of truth for the mirrored address, and that drifts. If Clerk Billing is ever adopted
 * again, this function is the one place to restore.
 */
function subscriptionMirror(
  _subscription: Awaited<ReturnType<typeof clerkSubscription>>
): SubscriptionMirror {
  return { plan: null, status: null, periodEnd: null };
}

function iso(value: Date | number | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function previewClerkReconciliation(
  targetUserId: string
): Promise<ClerkReconciliationPreview> {
  const db = await getDb();
  const local = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, targetUserId),
  });
  if (!local) throw new Error("No such Orbit account.");
  if (!process.env.CLERK_SECRET_KEY?.trim()) {
    throw new Error("Clerk reconciliation is not configured.");
  }

  const client = await clerkClient();
  const [user, subscription] = await Promise.all([
    client.users.getUser(targetUserId),
    clerkSubscription(targetUserId),
  ]);
  const canonicalEmail = primaryEmail(user);
  const mirror = subscriptionMirror(subscription);
  const changes: ReconciliationChange[] = [];
  const compare = (
    field: ReconciliationChange["field"],
    from: string | null,
    to: string | null
  ) => {
    if (from !== to) changes.push({ field, from, to });
  };
  compare("email", local.email, canonicalEmail);
  compare("subscriptionPlan", local.subscriptionPlan, mirror.plan);
  compare("subscriptionStatus", local.subscriptionStatus, mirror.status);
  compare(
    "subscriptionPeriodEnd",
    iso(local.subscriptionPeriodEnd),
    iso(mirror.periodEnd)
  );
  return { targetUserId, canonicalEmail, mirror, changes };
}

export async function reconcileClerkAccount(
  adminUserId: string,
  input: { targetUserId: string; reason: string }
): Promise<ClerkReconciliationPreview> {
  const reason = requireReason(input.reason, 8);
  const preview = await previewClerkReconciliation(input.targetUserId);
  if (preview.changes.length === 0) return preview;

  await setUserEmail(input.targetUserId, preview.canonicalEmail);
  await setSubscriptionState(input.targetUserId, preview.mirror, {
    eventKey: `admin-clerk-reconcile:${input.targetUserId}:${Date.now()}`,
  });
  await recordAdminAction({
    adminUserId,
    action: "account.reconcile.clerk",
    targetUserId: input.targetUserId,
    detail: { changes: preview.changes },
    reason,
  });
  await recordOperationalEvent({
    severity: "info",
    source: "admin",
    eventType: "account.reconciled.clerk",
    message: "An account was reconciled from Clerk.",
    success: true,
    userId: input.targetUserId,
    resourceType: "account",
    resourceId: input.targetUserId,
    metadata: { changedFields: preview.changes.length },
  });
  return preview;
}

export type StripeLifetimePreview = {
  targetUserId: string;
  sessionId: string;
  paymentStatus: string;
  amountTotal: number | null;
  currency: string | null;
  purchasedAt: string;
  alreadyGranted: boolean;
};

function stripeCustomerId(session: Stripe.Checkout.Session): string | null {
  if (!session.customer) return null;
  return typeof session.customer === "string" ? session.customer : session.customer.id;
}

export async function previewStripeLifetimeReconciliation(
  targetUserId: string,
  sessionId: string
): Promise<StripeLifetimePreview> {
  if (!/^cs_(test_|live_)?[A-Za-z0-9]+$/.test(sessionId.trim())) {
    throw new Error("Enter an exact Stripe Checkout Session ID.");
  }
  const db = await getDb();
  const local = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, targetUserId),
  });
  if (!local) throw new Error("No such Orbit account.");
  const session = await getStripe().checkout.sessions.retrieve(sessionId.trim());
  if (session.client_reference_id !== targetUserId) {
    throw new Error("This Checkout Session belongs to a different account.");
  }
  if (session.metadata?.[LIFETIME_METADATA_KEY] !== LIFETIME_METADATA_VALUE) {
    throw new Error("This Checkout Session is not an Orbit Lifetime purchase.");
  }
  if (session.payment_status === "unpaid") {
    throw new Error("This Checkout Session has not been paid.");
  }
  return {
    targetUserId,
    sessionId: session.id,
    paymentStatus: session.payment_status,
    amountTotal: session.amount_total,
    currency: session.currency,
    purchasedAt: new Date(session.created * 1000).toISOString(),
    alreadyGranted: local.lifetimePurchasedAt != null,
  };
}

export async function reconcileStripeLifetime(
  adminUserId: string,
  input: { targetUserId: string; sessionId: string; reason: string }
): Promise<StripeLifetimePreview> {
  const reason = requireReason(input.reason, 8);
  const preview = await previewStripeLifetimeReconciliation(
    input.targetUserId,
    input.sessionId
  );
  const session = await getStripe().checkout.sessions.retrieve(preview.sessionId);
  await setLifetimePurchase(input.targetUserId, {
    purchasedAt: new Date(preview.purchasedAt),
    stripeCustomerId: stripeCustomerId(session),
    eventKey: `admin-stripe-reconcile:${session.id}`,
  });
  await recordAdminAction({
    adminUserId,
    action: "account.reconcile.stripe_lifetime",
    targetUserId: input.targetUserId,
    resourceType: "stripe-checkout-session",
    resourceId: session.id,
    detail: { paymentStatus: preview.paymentStatus, alreadyGranted: preview.alreadyGranted },
    reason,
  });
  await recordOperationalEvent({
    severity: "info",
    source: "admin",
    eventType: "account.reconciled.stripe_lifetime",
    message: "A Lifetime purchase was reconciled from Stripe.",
    success: true,
    userId: input.targetUserId,
    resourceType: "stripe-checkout-session",
    resourceId: session.id,
    metadata: { alreadyGranted: preview.alreadyGranted },
  });
  return preview;
}
