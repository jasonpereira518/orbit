"use client";

import dynamic from "next/dynamic";
import { OnboardingPageSkeleton } from "@/components/loading/page-skeletons";
import type { OnboardingFlowProps } from "@/components/onboarding/onboarding-flow";

const OnboardingFlow = dynamic(
  () =>
    import("@/components/onboarding/onboarding-flow").then((m) => ({
      default: m.OnboardingFlow,
    })),
  {
    ssr: false,
    loading: () => <OnboardingPageSkeleton />,
  },
);

export function OnboardingFlowLazy(props: OnboardingFlowProps) {
  return <OnboardingFlow {...props} />;
}
