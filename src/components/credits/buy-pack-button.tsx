"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { startCreditPackCheckout } from "@/actions/billing";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";

/**
 * "Buy a pack ($5)" — one Stripe Checkout for 250 credits. Never automatic: the person sees
 * the price on Stripe's page and pays. The server refuses Free and Lifetime accounts anyway.
 */
export function BuyPackButton({
  size = "sm",
  variant = "default",
  label = "Buy a pack ($5)",
}: {
  size?: "sm" | "default";
  variant?: "default" | "outline";
  label?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        size={size}
        variant={variant}
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            try {
              const result = await startCreditPackCheckout();
              if ("url" in result) {
                // A full navigation: the destination is Stripe's domain.
                window.location.href = result.url;
                return;
              }
              setError(result.error);
            } catch (err) {
              setError(friendlyError(err, "Couldn’t start checkout — try again"));
            }
          })
        }
      >
        {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
        {pending ? "Opening checkout…" : label}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
