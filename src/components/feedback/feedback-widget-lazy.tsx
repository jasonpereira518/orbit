"use client";

import dynamic from "next/dynamic";

/**
 * The client boundary for the feedback widget.
 *
 * `dynamic(..., { ssr: false })` cannot be called from a Server Component in the App
 * Router, and `(app)/layout.tsx` is one — so this shim exists for the same reason
 * `onboarding-flow-lazy.tsx` does. No loading state: there is nothing to hold a place for
 * until the button itself renders.
 */
const FeedbackWidget = dynamic(
  () => import("@/components/feedback/feedback-widget").then((m) => ({ default: m.FeedbackWidget })),
  { ssr: false, loading: () => null }
);

export function FeedbackWidgetLazy({ viewingAsUser }: { viewingAsUser: boolean }) {
  return <FeedbackWidget viewingAsUser={viewingAsUser} />;
}
