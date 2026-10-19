"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { openBillingPortal } from "@/actions/billing";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";

/** Opens Stripe's portal: cancel, change card, download invoices. */
export function ManageBillingButton() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            try {
              const result = await openBillingPortal();
              if ("url" in result) {
                window.location.href = result.url;
                return;
              }
              setError(result.error);
            } catch (err) {
              setError(friendlyError(err, "Couldn’t open billing just now — try again in a moment"));
            }
          });
        }}
      >
        {pending && <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />}
        {pending ? "Opening…" : "Manage billing"}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
