"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { startProCheckout } from "@/actions/billing";
import { planCopy, type BillingPeriod } from "@/lib/plan-copy";
import { cn } from "@/lib/utils";

/**
 * Sends the buyer to Stripe Checkout for the Orbit Pro subscription, honouring the
 * page's billing-period toggle.
 *
 * The action returns a URL rather than redirecting so refusals (already subscribed,
 * not on sale yet) can be shown right here, next to the button that caused them.
 */
export function ProCheckoutButton({
  period,
  className,
}: {
  period: BillingPeriod;
  className?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Reads the amount from PLAN_COPY so the button can never quote a different price
  // than the card above it.
  const amount = planCopy("orbit").price[period].amount;
  const label = `Start Pro — ${amount}/${period === "annual" ? "year" : "month"}`;

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            const result = await startProCheckout(period);
            if ("url" in result) {
              // A full navigation, not router.push: the destination is Stripe's domain.
              window.location.href = result.url;
              return;
            }
            setError(result.error);
          });
        }}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-xl bg-[#eef7f4] px-4 py-3 text-sm font-medium text-[#0f2e28] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70",
          className
        )}
      >
        {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
        {pending ? "Opening checkout…" : label}
      </button>
      {error && (
        <p role="alert" className="text-center text-xs text-brand-pro">
          {error}
        </p>
      )}
    </div>
  );
}
