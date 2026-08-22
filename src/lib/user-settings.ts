import { cache } from "react";
import { and, count, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";

/**
 * How stale `last_active_at` must be before a request refreshes it.
 *
 * `ensureUserSettings` runs on *every* authenticated request via
 * `bootstrapAuthenticatedUser`, so an unconditional UPDATE here would add a database
 * round trip to the critical path of every page load. This throttle is what makes the
 * column affordable.
 */
const ACTIVITY_THROTTLE_MS = 15 * 60 * 1000;

/** Ensure a per-user settings row exists (idempotent). Cached per request. */
export const ensureUserSettings = cache(async (userId: string) => {
  const db = await getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (existing) return await touchLastActive(existing);

  const [created] = await db
    .insert(userSettings)
    .values({ userId, lastActiveAt: new Date() })
    .returning();
  return created;
});

/**
 * Refreshes `last_active_at`, at most once per user per `ACTIVITY_THROTTLE_MS`.
 *
 * Awaited rather than deferred, which is worth explaining because deferring looks more
 * attractive than it is. Both obvious ways to defer are traps:
 *
 *  - `after()` means importing `next/server` into this module. `user-settings.ts` sits near
 *    the bottom of the import graph — every script and background job pulls it in — and
 *    that import alone keeps the Node event loop alive, hanging any script that exits by
 *    draining rather than calling `process.exit` (`scripts/smoke-entitlements.ts` does).
 *  - A bare un-awaited promise has the same effect: a pending PGlite write also holds the
 *    loop open.
 *
 * Awaiting costs one extra UPDATE per user per 15 minutes — `ensureUserSettings` is
 * `cache()`d per request, so a single page load can trigger it at most once, and only when
 * the stamp has actually gone stale. That is a fair price for a chokepoint this widely
 * imported staying free of runtime-specific dependencies.
 *
 * The staleness decision uses the row already fetched, so it costs zero extra reads, and
 * the WHERE clause re-checks it so concurrent requests cannot double-write. It deliberately
 * does NOT touch `updated_at`, which means "settings changed" and would be poisoned for
 * every other use if it also meant "user was online".
 */
async function touchLastActive<T extends { userId: string; lastActiveAt: Date | null }>(
  row: T
): Promise<T> {
  const now = Date.now();
  if (row.lastActiveAt && now - row.lastActiveAt.getTime() < ACTIVITY_THROTTLE_MS) {
    return row;
  }

  const stale = new Date(now - ACTIVITY_THROTTLE_MS);
  const stampedAt = new Date();

  try {
    const db = await getDb();
    await db
      .update(userSettings)
      .set({ lastActiveAt: stampedAt })
      .where(
        and(
          eq(userSettings.userId, row.userId),
          or(
            isNull(userSettings.lastActiveAt),
            lt(userSettings.lastActiveAt, stale)
          )
        )
      );
    return { ...row, lastActiveAt: stampedAt };
  } catch {
    // An activity stamp is never worth failing a request over.
    return row;
  }
}

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

/**
 * The only writer of `comped_plan` anywhere in the codebase.
 *
 * `resolvePlan` treats this column as outranking lifetime, subscription and everything
 * else — permanently, with no expiry and no webhook that would ever correct it. Both
 * `scripts/grant-plan.ts` and the admin console route through here so the CLI and the UI
 * cannot drift apart.
 *
 * Returns the updated row so callers can resolve the new plan from it directly. Do NOT
 * call `getEntitlements` after this in the same request: it is a React `cache()` memo and
 * may still hold the pre-write value for this user.
 */
export async function setCompedPlan(
  userId: string,
  plan: "orbit" | "lifetime" | null,
  opts: { note?: string | null; adminUserId?: string | null } = {}
) {
  await ensureUserSettings(userId);
  const db = await getDb();

  const [row] = await db
    .update(userSettings)
    .set({
      compedPlan: plan,
      // Clearing a comp clears its provenance too, so a later grant never inherits a
      // stale reason from the previous one.
      compedNote: plan ? (opts.note?.trim() || null) : null,
      compedAt: plan ? new Date() : null,
      compedBy: plan ? (opts.adminUserId ?? null) : null,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId))
    .returning();

  return row;
}

/**
 * Accounts matching an email, for the admin comp lookup.
 *
 * Returns every match rather than the first: `user_settings.email` has no unique
 * constraint on purpose (two accounts may legitimately transit the same address), so
 * auto-picking would eventually comp the wrong account.
 */
export async function findUsersByEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return [];

  const db = await getDb();
  return db.query.userSettings.findMany({
    where: eq(userSettings.email, normalized),
  });
}
