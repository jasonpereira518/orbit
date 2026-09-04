"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { resetOnboarding } from "@/actions/onboarding";
import { resetWizard } from "@/actions/onboarding-wizard";
import { Button } from "@/components/ui/button";
import { requestFeedbackOpen } from "@/lib/feedback-events";
import { PANEL_ORIGIN_FALLBACK } from "@/lib/floating-panel";

export function HelpSettings({ feedbackEnabled }: { feedbackEnabled: boolean }) {
  const router = useRouter();
  const [tourPending, startTour] = useTransition();
  const [wizardPending, startWizard] = useTransition();

  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Help</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Replay the first-run walkthrough, jump straight into a guided setup for adding
          people to your orbit, or tell us what isn&apos;t working.
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
        {/* The third door into the one mounted widget, alongside the floating button and
            the mobile "More" sheet — and gone when the widget is, since it dispatches an
            event at a component that would not be mounted. */}
        {feedbackEnabled && (
        <Button
          variant="outline"
          size="sm"
          // Mid-page, so anchoring the window to this button would fly it in from
          // wherever the page happens to be scrolled.
          onClick={() => requestFeedbackOpen(PANEL_ORIGIN_FALLBACK)}
        >
          Send feedback
        </Button>
        )}
      </div>
    </section>
  );
}
