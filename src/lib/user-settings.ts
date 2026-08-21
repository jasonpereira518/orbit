import { cache } from "react";
import { count, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";

/** Ensure a per-user settings row exists (idempotent). Cached per request. */
export const ensureUserSettings = cache(async (userId: string) => {
  const db = await getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (existing) return existing;

  const [created] = await db
    .insert(userSettings)
    .values({ userId })
    .returning();
  return created;
});

/**
 * Mirrors the user's own email from Clerk into the DB, so background work (which has no
 * request context) can reach them without a Clerk API call.
 *
 * Writes only on change: `user.updated` fires for many unrelated profile edits, and this
 * is also called opportunistically on page loads.
 */
export async function setUserEmail(userId: string, email: string | null) {
  const normalized = email?.trim().toLowerCase() || null;
  const existing = await ensureUserSettings(userId);
  if (existing?.email === normalized) return;

  const db = await getDb();
  await db
    .update(userSettings)
    .set({ email: normalized, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}

/**
 * Clerk timestamps are unix epochs, but the units vary by field across the API surface.
 * Anything below ~2001-09 in milliseconds is far more likely to be seconds.
 */
function epochToDate(value: number | null | undefined): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value < 1e12 ? value * 1000 : value);
}

export type SubscriptionMirror = {
  plan: "orbit" | null;
  status: "active" | "past_due" | "canceled" | null;
  periodEnd: number | null;
};

/**
 * Mirrors Clerk subscription state into `user_settings`, for the same reason
 * `setUserEmail` mirrors the address: Clerk's `has({ plan })` needs an active request
 * context, so background work (the import job processor, the ICS feed) could never ask
 * Clerk directly. `src/lib/entitlements.ts` reads these columns and nothing else, which
 * keeps request and background code resolving the same plan.
 *
 * NOTE: the `subscriptionItem.*` events must also be enabled on this endpoint's
 * subscription in the Clerk Dashboard — handling them in code alone is not enough.
 */
export async function setSubscriptionState(
  userId: string,
  mirror: SubscriptionMirror
) {
  await ensureUserSettings(userId);
  const db = await getDb();
  await db
    .update(userSettings)
    .set({
      subscriptionPlan: mirror.plan,
      subscriptionStatus: mirror.status,
      subscriptionPeriodEnd: epochToDate(mirror.periodEnd),
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId));
}

/**
 * Records a completed Lifetime purchase. Idempotent: Stripe retries `checkout.session
 * .completed`, and the first purchase timestamp is the one worth keeping.
 */
export async function setLifetimePurchase(
  userId: string,
  opts: { purchasedAt?: Date; stripeCustomerId?: string | null } = {}
) {
  const existing = await ensureUserSettings(userId);
  if (existing?.lifetimePurchasedAt) return;

  const db = await getDb();
  await db
    .update(userSettings)
    .set({
      lifetimePurchasedAt: opts.purchasedAt ?? new Date(),
      stripeCustomerId: opts.stripeCustomerId ?? existing?.stripeCustomerId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId));
}

/** How many Lifetime seats have been sold, for the early-adopter cap. */
export async function countLifetimePurchases() {
  const db = await getDb();
  const [row] = await db
    .select({ value: count() })
    .from(userSettings)
    .where(isNotNull(userSettings.lifetimePurchasedAt));
  return row?.value ?? 0;
}
