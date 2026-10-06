import { redirect } from "next/navigation";
import { getGmailConnectionStatus } from "@/actions/gmail";
import { getOutlookConnectionStatus } from "@/actions/outlook";
import { getSettings } from "@/actions/settings";
import { OnboardingFlowLazy } from "@/components/onboarding/onboarding-flow-lazy";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { needsTermsAcceptance } from "@/lib/legal";
import { hasLinkedInImport } from "@/lib/linkedin-reminder";
import { connectAccountFromGmail, connectAccountFromOutlook } from "@/lib/onboarding-connect";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";
import { tourInProgress } from "@/lib/tour/tour-state";
import { claimSiteInviteGrant } from "@/lib/site-invites";
import { ensureUserSettings } from "@/lib/user-settings";

export default async function OnboardingPage() {
  const userId = await requireUserId();
  const settings = await ensureUserSettings(userId);

  // The gate flag alone decides, never `needsOnboarding()`: adding people mid-flow makes
  // that false, and this page must keep rendering until the person leaves. A set step with
  // the flag set is a replay from Settings on a populated account (the gate's backfill
  // re-stamps the flag but leaves the step), so that combination renders too.
  if (settings.onboardingCompletedAt && !settings.onboardingStep) {
    redirect("/dashboard");
  }
  // A tour that already handed off resumes in the app, not here.
  if (tourInProgress(settings)) {
    redirect("/dashboard");
  }

  // Every invited sign-up passes through here first (`/sign-up` forces this redirect), so
  // this is where a missed `user.created` webhook is made up for: an invited account gets its
  // founding-pricing eligibility before it ever sees a price.
  if (!settings.foundingEligible) await claimSiteInviteGrant(userId);

  const [aiSettings, entitlements, visibility, gmail, outlook, linkedinImported] =
    await Promise.all([
      getSettings(),
      getEntitlements(userId),
      resolveSurfaceVisibility(userId),
      getGmailConnectionStatus(),
      getOutlookConnectionStatus(),
      hasLinkedInImport(userId),
    ]);

  return (
    <OnboardingFlowLazy
      initialStepId={settings.onboardingStep}
      initialPath={settings.onboardingPath}
      needsTerms={needsTermsAcceptance(settings.termsVersion)}
      hasApiKey={aiSettings.hasApiKey}
      linkedinRequested={settings.linkedinExportRequestedAt != null}
      linkedinImported={linkedinImported}
      hidden={[...visibility.hidden]}
      comingSoon={[...visibility.comingSoon]}
      connect={{
        google: connectAccountFromGmail(gmail),
        microsoft: connectAccountFromOutlook(outlook),
      }}
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
