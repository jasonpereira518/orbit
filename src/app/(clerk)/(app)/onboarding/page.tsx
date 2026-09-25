import { redirect } from "next/navigation";
import { OnboardingFlowLazy } from "@/components/onboarding/onboarding-flow-lazy";
import { requireUserId } from "@/lib/auth";
import { claimSiteInviteGrant } from "@/lib/site-invites";
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

  // Every invited sign-up passes through here first (`/sign-up` forces this redirect), so
  // this is where a missed `user.created` webhook is made up for: an invited account that
  // has no comp yet gets its Orbit plan before it ever meets a paywall.
  if (!settings.compedPlan) await claimSiteInviteGrant(userId);

  return <OnboardingFlowLazy initialStepId={settings.onboardingStep} />;
}
