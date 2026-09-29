"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { startSubscriptionCheckout } from "@/actions/billing";
import { planCopy } from "@/lib/plan-copy";
import type { PurchasablePlan } from "@/lib/plans/plan-config";
import { cn } from "@/lib/utils";

/**
 * Sends the buyer to Stripe Checkout for Orbit Pro or Orbit Max, monthly.
 *
 * The action returns a URL rather than redirecting so refusals (already subscribed, not on
 * sale yet) show right here, next to the button that caused them. A founding discount, when
 * the account has one, is applied by the action and shown by Stripe's checkout page — the
 * label always quotes the list price the card above it shows.
 */
export function SubscriptionCheckoutButton({
  plan,
  className,
}: {
  plan: PurchasablePlan;
  className?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const copy = planCopy(plan);
  const label = `Start ${copy.name.replace("Orbit ", "")} — ${copy.price.amount}/month`;

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            const result = await startSubscriptionCheckout(plan);
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
        <p role="alert" className="text-center text-xs text-[#e8f3f1]">
          {error}
        </p>
      )}
    </div>
  );
}
