"use client";

import dynamic from "next/dynamic";
import { OnboardingPageSkeleton } from "@/components/loading/page-skeletons";

const SetupWizard = dynamic(
  () =>
    import("@/components/onboarding/wizard/setup-wizard").then((m) => ({
      default: m.SetupWizard,
    })),
  {
    ssr: false,
    loading: () => <OnboardingPageSkeleton />,
  }
);

export function SetupWizardLazy({
  initialStepId = null,
  hasApiKey = true,
  googleConfigured,
  contactLimit,
  linkedInRequested = false,
}: {
  initialStepId?: string | null;
  hasApiKey?: boolean;
  googleConfigured: boolean;
  contactLimit: number | null;
  linkedInRequested?: boolean;
}) {
  return (
    <SetupWizard
      initialStepId={initialStepId}
      hasApiKey={hasApiKey}
      googleConfigured={googleConfigured}
      contactLimit={contactLimit}
      linkedInRequested={linkedInRequested}
    />
  );
}
