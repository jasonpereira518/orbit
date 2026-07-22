"use client";

import dynamic from "next/dynamic";
import { OnboardingPageSkeleton } from "@/components/loading/page-skeletons";

const OnboardingFlow = dynamic(
  () =>
    import("@/components/onboarding/onboarding-flow").then((m) => ({
      default: m.OnboardingFlow,
    })),
  {
    ssr: false,
    loading: () => <OnboardingPageSkeleton />,
  }
);

export function OnboardingFlowLazy({
  initialStepId = null,
}: {
  initialStepId?: string | null;
}) {
  return <OnboardingFlow initialStepId={initialStepId} />;
}
