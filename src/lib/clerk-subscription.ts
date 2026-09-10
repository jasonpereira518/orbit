import type { SubscriptionMirror } from "@/lib/user-settings";

/** Canonical mapping shared by webhook delivery and an operator-requested reconciliation. */
export function mirrorForClerkStatus(
  status: string,
  periodEnd: number | null
): SubscriptionMirror | null {
  switch (status) {
    case "active":
      return { plan: "orbit", status: "active", periodEnd };
    case "past_due":
      return { plan: "orbit", status: "past_due", periodEnd };
    case "canceled":
      return { plan: "orbit", status: "canceled", periodEnd };
    case "ended":
    case "expired":
    case "abandoned":
    case "incomplete":
      return { plan: null, status: null, periodEnd: null };
    case "upcoming":
      return null;
    default:
      return null;
  }
}
