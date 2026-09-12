"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { startLifetimeCheckout } from "@/actions/billing";
import { cn } from "@/lib/utils";

/**
 * Sends the buyer to Stripe Checkout.
 *
 * The action returns a URL rather than redirecting so refusals (already owned, not on
 * sale) can be shown right here, next to the button that caused them.
 */
export function LifetimeCheckoutButton({
  priceUsd,
  className,
}: {
  /**
   * Passed in rather than hardcoded. The button names the price it is about to charge, so
   * a stale literal here would be the label disagreeing with the checkout it opens.
   */
  priceUsd: number;
  className?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            const result = await startLifetimeCheckout();
            if ("url" in result) {
              // A full navigation, not router.push: the destination is Stripe's domain.
              window.location.href = result.url;
              return;
            }
            setError(result.error);
          });
        }}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-xl bg-[#f2c14e] px-4 py-3 text-sm font-medium text-[#241a00] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70",
          className
        )}
      >
        {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
        {pending ? "Opening checkout…" : `Get Orbit Lifetime — $${priceUsd}`}
      </button>
      {error && (
        <p role="alert" className="text-center text-xs text-[#f2c14e]">
          {error}
        </p>
      )}
    </div>
  );
}
