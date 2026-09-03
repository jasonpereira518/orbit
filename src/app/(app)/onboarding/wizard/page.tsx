import { redirect } from "next/navigation";
import { getSettings } from "@/actions/settings";
import { getWizardStatus } from "@/actions/onboarding-wizard";
import { getLinkedInExportStatus } from "@/actions/linkedin-export";
import { SetupWizardLazy } from "@/components/onboarding/wizard/setup-wizard-lazy";
import { isGmailConfigured } from "@/lib/gmail";

export default async function OnboardingWizardPage() {
  const [status, settings, linkedInExport] = await Promise.all([
    getWizardStatus(),
    getSettings(),
    getLinkedInExportStatus(),
  ]);

  // Gated only on wizard completion — independent of tour state, so it's
  // reachable from Settings ("Run guided setup") even after the tour is done.
  if (status.completed) {
    redirect("/dashboard");
  }

  return (
    <SetupWizardLazy
      initialStepId={status.step}
      hasApiKey={settings.hasApiKey}
      googleConfigured={isGmailConfigured()}
      contactLimit={settings.plan.contactLimit}
      linkedInRequested={Boolean(
        linkedInExport.requestedAt || linkedInExport.hasLinkedInImport
      )}
    />
  );
}
