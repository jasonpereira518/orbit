"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { answerSurvey, dismissSurvey, getSurveyPrompt, markSurveyShown, type SurveyPrompt } from "@/actions/surveys";
import { FEEDBACK_ANCHOR_FALLBACK, requestFeedbackOpen } from "@/lib/feedback-events";

/**
 * The micro-survey: one closed question, in the corner, at the moment the answer is freshest.
 *
 * QUIET BY CONSTRUCTION. It asks the server for a survey only after the page has been idle,
 * renders nothing when there is none (which is nearly always), never takes focus, never
 * blocks anything, and does not return once answered or dismissed. The rules for when a survey
 * is due live in `src/lib/survey-eligibility.ts`; this only draws what it is handed.
 *
 * Answers are closed choices (`src/lib/surveys.ts`). Anything someone wants to say in their own
 * words goes through the feedback widget, which "Tell us more" opens.
 */

const IDLE_MS = 4_000;

export function SurveyPrompt({ canSendFeedback }: { canSendFeedback: boolean }) {
  const [survey, setSurvey] = useState<SurveyPrompt | null>(null);
  const [answered, setAnswered] = useState(false);
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    const timer = window.setTimeout(() => {
      void getSurveyPrompt().then((found) => {
        if (!found) return;
        setSurvey(found);
        void markSurveyShown(found.id);
      });
    }, IDLE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (!survey) return null;

  const close = () => setSurvey(null);

  return (
    <section
      aria-label="A quick question"
      className="fixed bottom-4 left-4 z-40 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-border/70 bg-card p-4 text-sm shadow-lg"
    >
      <button
        type="button"
        aria-label="Not now"
        onClick={() => {
          void dismissSurvey(survey.id);
          close();
        }}
        className="absolute right-2 top-2 rounded p-1 text-muted-foreground transition-colors duration-fast hover:text-foreground"
      >
        <X className="size-3.5" aria-hidden />
      </button>
      {answered ? (
        <div className="pr-5">
          <p className="font-medium">Thanks, that helps.</p>
          {canSendFeedback && (
            <button
              type="button"
              onClick={() => {
                requestFeedbackOpen(FEEDBACK_ANCHOR_FALLBACK);
                close();
              }}
              className="mt-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Tell us more
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="pr-5 font-medium">{survey.question}</p>
          <p className="mt-1 text-xs text-muted-foreground">{survey.why}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {survey.options.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  setAnswered(true);
                  void answerSurvey(survey.id, option.id);
                }}
                className="rounded-lg border border-border/70 px-2.5 py-1 text-xs transition-colors duration-fast hover:bg-muted"
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
