import type { Plan } from "@/lib/plan-limits";

/** The billing signal that currently grants the resolved plan. */
export type PlanSource = "comp" | "lifetime" | "subscription" | "free";

export type BillingColumns = {
  compedPlan?: "orbit" | "lifetime" | null;
  lifetimePurchasedAt?: Date | null;
  subscriptionPlan?: "orbit" | null;
  subscriptionStatus?: "active" | "past_due" | "canceled" | null;
  subscriptionPeriodEnd?: Date | null;
};

/** A paid period remains live after cancellation until its already-paid end date. */
export function subscriptionIsLive(row: BillingColumns, now: Date) {
  if (row.subscriptionPlan !== "orbit") return false;
  if (row.subscriptionStatus === "active") return true;
  if (!row.subscriptionPeriodEnd) return false;
  return row.subscriptionPeriodEnd.getTime() > now.getTime();
}

/** Precedence: comp > lifetime > subscription > free. */
export function resolvePlan(
  row: BillingColumns | null | undefined,
  now = new Date()
): { plan: Plan; source: PlanSource } {
  if (!row) return { plan: "free", source: "free" };
  if (row.compedPlan === "lifetime") return { plan: "lifetime", source: "comp" };
  if (row.compedPlan === "orbit") return { plan: "orbit", source: "comp" };
  if (row.lifetimePurchasedAt) return { plan: "lifetime", source: "lifetime" };
  if (subscriptionIsLive(row, now)) {
    return { plan: "orbit", source: "subscription" };
  }
  return { plan: "free", source: "free" };
}
