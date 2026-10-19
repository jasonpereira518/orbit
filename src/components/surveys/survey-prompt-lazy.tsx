"use client";

import dynamic from "next/dynamic";

/**
 * The client boundary for the survey prompt, for the reason `FeedbackWidgetLazy` gives:
 * `dynamic(..., { ssr: false })` cannot be called from the Server Component layout. Nothing
 * is rendered until a survey is actually due, so there is no loading state to hold a place.
 */
const SurveyPrompt = dynamic(
  () => import("@/components/surveys/survey-prompt").then((m) => ({ default: m.SurveyPrompt })),
  { ssr: false, loading: () => null }
);

export function SurveyPromptLazy({ canSendFeedback }: { canSendFeedback: boolean }) {
  return <SurveyPrompt canSendFeedback={canSendFeedback} />;
}
