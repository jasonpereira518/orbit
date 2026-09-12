import type { BillingEventKind } from "@/db/schema";
import { classifyMovement } from "@/lib/billing-events";

/**
 * Rebuilding the ledger from Stripe's object history.
 *
 * WHY OBJECTS AND NOT EVENTS. Stripe retains events for 30 days, so an events-based
 * backfill is a backfill of the last month. Subscriptions, invoices, refunds and disputes
 * have no retention window, so history is reconstructed from them instead.
 *
 * THE REPLAY PROBLEM, AND WHY THIS MODULE IS PURE. `classifyMovement` needs the value
 * before a change, and the live webhook gets it by reading the mirror. A replay cannot:
 * `user_settings` has already moved past every historical transition, so reading it would
 * classify all of history against today. But a replay does not need to read anything — it
 * IS the history, so it can carry "before" in memory and walk forward. That is what
 * `replayMovements` does, and keeping it free of IO is what makes it testable without a
 * Stripe account or a database.
 *
 * Current `user_settings` is the OUTPUT of this history. Using it as an input is the bug.
 */

/** Prefix for backfilled MRR rows. Kept distinguishable from real Stripe ids forever. */
export const BACKFILL_PREFIX = "bf:";

export type SubscriptionMovement = {
  userId: string;
  at: Date;
  /** Recurring value after this transition, in cents per month. */
  afterCents: number;
  subscriptionId: string;
  slot: "new" | "churn";
  detail?: Record<string, unknown>;
};

export type PlannedBooking = {
  eventId: string;
  kind: BillingEventKind;
  userId: string | null;
  amountCents: number;
  mrrDeltaCents: number;
  effectiveAt: Date;
  detail: Record<string, unknown>;
};

/**
 * Walk a subscription timeline forward, classifying each transition against the value
 * that preceded it.
 *
 * Sorted globally by timestamp rather than grouped per user, because `hadPriorRevenue` is
 * a per-user fact that only becomes true partway through and a per-user pass would still
 * be correct — but a single ordered pass makes the invariant obvious rather than
 * incidental, and the volume does not justify cleverness.
 *
 * `until` drops movements at or after the cutover: everything before it belongs to the
 * backfill, everything after belongs to the live webhook, and nothing is booked twice.
 */
export function replayMovements(
  movements: SubscriptionMovement[],
  until: Date | null
): PlannedBooking[] {
  const ordered = [...movements].sort((a, b) => a.at.getTime() - b.at.getTime());

  const value = new Map<string, number>();
  const everPaid = new Set<string>();
  const planned: PlannedBooking[] = [];

  for (const movement of ordered) {
    const before = value.get(movement.userId) ?? 0;
    const hadPriorRevenue = everPaid.has(movement.userId);

    // State advances even for movements past the cutoff, so that a later in-window
    // movement is still classified against the right "before". Only the BOOKING is
    // skipped — skipping the state update too would corrupt everything after it.
    const classified = classifyMovement(before, movement.afterCents, {
      hadPriorRevenue,
    });
    value.set(movement.userId, movement.afterCents);
    if (movement.afterCents > 0) everPaid.add(movement.userId);

    if (!classified) continue;
    if (until && movement.at.getTime() >= until.getTime()) continue;

    planned.push({
      eventId: `${BACKFILL_PREFIX}${movement.subscriptionId}:${movement.slot}`,
      kind: movement.slot === "churn" ? "churn" : classified.kind,
      userId: movement.userId,
      amountCents: 0,
      mrrDeltaCents: classified.deltaCents,
      effectiveAt: movement.at,
      detail: {
        ...movement.detail,
        backfilled: true,
        subscriptionId: movement.subscriptionId,
        beforeCents: before,
        afterCents: movement.afterCents,
      },
    });
  }

  return planned;
}

/**
 * Whether a planned MRR row looks like one the webhook already wrote.
 *
 * The cutoff is the primary defence; this is the belt to its braces, for the case where a
 * webhook row's `effective_at` sits marginally before the computed cutover. Matched on
 * user, kind and amount within a tolerance, because the two paths derive the timestamp
 * from different fields and will not agree to the second.
 */
export function looksAlreadyBooked(
  planned: PlannedBooking,
  existing: Array<{
    userId: string | null;
    kind: string;
    mrrDeltaCents: number;
    effectiveAt: Date;
  }>,
  toleranceMs = 10 * 60 * 1000
): boolean {
  return existing.some(
    (row) =>
      row.userId === planned.userId &&
      row.kind === planned.kind &&
      row.mrrDeltaCents === planned.mrrDeltaCents &&
      Math.abs(row.effectiveAt.getTime() - planned.effectiveAt.getTime()) <= toleranceMs
  );
}
