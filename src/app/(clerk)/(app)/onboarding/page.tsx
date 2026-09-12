import { redirect } from "next/navigation";
import { OnboardingFlowLazy } from "@/components/onboarding/onboarding-flow-lazy";
import { requireUserId } from "@/lib/auth";
import { ensureUserSettings } from "@/lib/user-settings";

export default async function OnboardingPage() {
  const userId = await requireUserId();
  const settings = await ensureUserSettings(userId);

  // Replay from Settings clears this flag; first-run users also have it unset.
  // needsOnboarding() intentionally skips users who already have contacts on
  // main routes — this page uses the completion flag directly instead.
  if (settings.onboardingCompletedAt) {
    redirect("/dashboard");
  }

  return <OnboardingFlowLazy initialStepId={settings.onboardingStep} />;
}
