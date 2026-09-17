import { redirect } from "next/navigation";
import { getSettings } from "@/actions/settings";
import { OnboardingFlowLazy } from "@/components/onboarding/onboarding-flow-lazy";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";
import { ensureUserSettings } from "@/lib/user-settings";

export default async function OnboardingPage() {
  const userId = await requireUserId();
  const settings = await ensureUserSettings(userId);

  // Replay from Settings clears this flag; first-run users also have it unset.
  //
  // Only the flag, never `needsOnboarding()`: adding people mid-flow makes that false, and
  // this page must keep rendering (through triage and the done step) until the user leaves.
  // The layout's gate never runs `needsOnboarding` for `/onboarding` itself, so its
  // "has contacts → mark complete" backfill cannot fire from here either.
  if (settings.onboardingCompletedAt) {
    redirect("/dashboard");
  }

  const [aiSettings, entitlements, visibility] = await Promise.all([
    getSettings(),
    getEntitlements(userId),
    resolveSurfaceVisibility(userId),
  ]);

  return (
    <OnboardingFlowLazy
      initialStepId={settings.onboardingStep}
      hasApiKey={aiSettings.hasApiKey}
      linkedinRequested={settings.linkedinExportRequestedAt != null}
      hidden={[...visibility.hidden]}
      planFlags={{
        canUseOutreach: entitlements.canUseOutreach,
        canUseHostedSending: entitlements.canUseHostedSending,
        canUseRecruiters: entitlements.canUseRecruiters,
        canUseSync: entitlements.canUseSync,
        canUseExtension: entitlements.canUseExtension,
        canUseApi: entitlements.canUseApi,
      }}
    />
  );
}
