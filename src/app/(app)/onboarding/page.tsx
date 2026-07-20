import { redirect } from "next/navigation";
import { OnboardingFlowLazy } from "@/components/onboarding/onboarding-flow-lazy";
import { requireUserId } from "@/lib/auth";
import { needsOnboarding } from "@/lib/onboarding";

export default async function OnboardingPage() {
  const userId = await requireUserId();
  const showOnboarding = await needsOnboarding(userId);

  if (!showOnboarding) {
    redirect("/dashboard");
  }

  return <OnboardingFlowLazy />;
}
