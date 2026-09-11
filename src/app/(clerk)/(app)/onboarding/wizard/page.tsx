import { redirect } from "next/navigation";
import { getSettings } from "@/actions/settings";
import { getWizardStatus } from "@/actions/onboarding-wizard";
import { SetupWizardLazy } from "@/components/onboarding/wizard/setup-wizard-lazy";

export default async function OnboardingWizardPage() {
  const [status, settings] = await Promise.all([
    getWizardStatus(),
    getSettings(),
  ]);

  // Gated only on wizard completion — independent of tour state, so it's
  // reachable from Settings ("Run guided setup") even after the tour is done.
  if (status.completed) {
    redirect("/dashboard");
  }

  return (
    <SetupWizardLazy initialStepId={status.step} hasApiKey={settings.hasApiKey} />
  );
}
