"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { resetOnboarding } from "@/actions/onboarding";
import { Button } from "@/components/ui/button";

export function HelpSettings() {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-primary">Help</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Replay the first-run walkthrough for adding people to your orbit.
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await resetOnboarding();
            router.replace(res.redirectTo);
            router.refresh();
          })
        }
      >
        Start tutorial
      </Button>
    </section>
  );
}
