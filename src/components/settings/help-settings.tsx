"use client";

import { useTransition } from "react";
import { resetOnboarding } from "@/actions/onboarding";
import { resumeTour } from "@/actions/tour";
import { Button } from "@/components/ui/button";
import { FEEDBACK_ANCHOR_FALLBACK, requestFeedbackOpen } from "@/lib/feedback-events";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { SettingsRow } from "@/components/settings/settings-section";
import type { OnboardingPath } from "@/lib/onboarding-steps";

export function HelpSettings({
  feedbackEnabled,
  tourResumable = false,
}: {
  feedbackEnabled: boolean;
  /** An in-app tour was exited part-way: offer to pick it up before offering to start over. */
  tourResumable?: boolean;
}) {
  const [pending, start] = useTransition();

  const go = (run: () => Promise<{ redirectTo: string }>) =>
    start(async () => {
      try {
        const res = await run();
        // A full load: the action revalidates, and its response landing after a client
        // navigation can snap the router back here (and the tour rail mounts or unmounts).
        window.location.assign(res.redirectTo);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t open that — try again?"));
      }
    });

  return (
    <SettingsRow
      id="settings-help"
      title="Help"
      description="Walk through setup again, take the page-by-page tour, or tell us what isn’t working."
    >
      <div className="flex flex-wrap gap-2">
        {tourResumable && (
          <Button size="sm" disabled={pending} onClick={() => go(resumeTour)}>
            Resume tour
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={pending} onClick={() => go(() => resetOnboarding({ path: "tour" satisfies OnboardingPath }))}>
          Take the tour again
        </Button>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => go(() => resetOnboarding({ path: "quick" }))}>
          Quick setup again
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
