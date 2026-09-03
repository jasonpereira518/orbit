"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { resetOnboarding } from "@/actions/onboarding";
import { resetWizard } from "@/actions/onboarding-wizard";
import { Button } from "@/components/ui/button";

export function HelpSettings() {
  const router = useRouter();
  const [tourPending, startTour] = useTransition();
  const [wizardPending, startWizard] = useTransition();

  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Help</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Replay the first-run walkthrough, or jump straight into a guided
          setup for adding people to your orbit.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={tourPending}
          onClick={() =>
            startTour(async () => {
              const res = await resetOnboarding();
              router.replace(res.redirectTo);
              router.refresh();
            })
          }
        >
          Replay tour
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={wizardPending}
          onClick={() =>
            startWizard(async () => {
              const res = await resetWizard();
              router.replace(res.redirectTo);
              router.refresh();
            })
          }
        >
          Run guided setup
        </Button>
      </div>
    </section>
  );
}
