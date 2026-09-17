"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { resetOnboarding } from "@/actions/onboarding";
import { Button } from "@/components/ui/button";
import { FEEDBACK_ANCHOR_FALLBACK, requestFeedbackOpen } from "@/lib/feedback-events";
import { SettingsRow } from "@/components/settings/settings-section";

export function HelpSettings({ feedbackEnabled }: { feedbackEnabled: boolean }) {
  const router = useRouter();
  const [replayPending, startReplay] = useTransition();

  return (
    <SettingsRow
      id="settings-help"
      title="Help"
      description="Walk through setup again — the LinkedIn export, a tour of what Orbit does, and adding people — or tell us what isn’t working."
    >
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={replayPending}
          onClick={() =>
            startReplay(async () => {
              const res = await resetOnboarding();
              router.replace(res.redirectTo);
              router.refresh();
            })
          }
        >
          Replay onboarding
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
          onClick={() => requestFeedbackOpen(FEEDBACK_ANCHOR_FALLBACK)}
        >
          Send feedback
        </Button>
        )}
      </div>
    </SettingsRow>
  );
}
