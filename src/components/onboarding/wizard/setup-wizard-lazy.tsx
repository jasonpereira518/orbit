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
  termsAccepted = true,
}: {
  initialStepId?: string | null;
  hasApiKey?: boolean;
  termsAccepted?: boolean;
}) {
  return (
    <SetupWizard
      initialStepId={initialStepId}
      hasApiKey={hasApiKey}
      termsAccepted={termsAccepted}
    />
  );
}
