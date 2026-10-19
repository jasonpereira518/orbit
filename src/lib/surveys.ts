/**
 * The micro-surveys: one closed question each, asked at the moment the answer is freshest.
 *
 * Client-safe (no database, no `next/*`): the prompt renders these and the server action
 * validates an answer against the same list, so the two cannot disagree about what a valid
 * answer is. Every answer is an `id` matching `^[a-z_]{1,32}$` — closed choices only, because
 * the answer is recorded as a `survey_answered` product event, and events never carry text a
 * person wrote. Anything they want to say in their own words goes through the feedback widget.
 *
 * Why these five, and when, is in TRACKING_PLAN.md §4 and ANALYTICS_PLAN.md §4.1.
 */

export type SurveyId = "post_first_capture" | "day7_not_activated" | "followup_useful" | "pmf" | "cancellation";

export type SurveyDefinition = {
  id: SurveyId;
  question: string;
  /** One line under the question: why it is being asked, in the person's terms. */
  why: string;
  options: ReadonlyArray<{ id: string; label: string }>;
};

export const SURVEY_DEFINITIONS: Record<SurveyId, SurveyDefinition> = {
  post_first_capture: {
    id: "post_first_capture",
    question: "Did Orbit get the people right?",
    why: "You just saved your first capture. One tap helps us know whether it can be trusted.",
    options: [
      { id: "yes", label: "Yes" },
      { id: "mostly", label: "Mostly" },
      { id: "no", label: "No" },
    ],
  },
  day7_not_activated: {
    id: "day7_not_activated",
    question: "What got in the way of adding your network?",
    why: "You signed up a week ago and haven't got going yet. Knowing why helps us fix it.",
    options: [
      { id: "no_time", label: "I haven't had time" },
      { id: "no_notes", label: "I don't have notes to add" },
      { id: "import_failed", label: "An import didn't work" },
      { id: "not_for_me", label: "I'm not sure it's for me" },
      { id: "other", label: "Something else" },
    ],
  },
  followup_useful: {
    id: "followup_useful",
    question: "Was that reminder useful?",
    why: "You just finished your first follow-up.",
    options: [
      { id: "yes", label: "Yes" },
      { id: "too_early", label: "Too early" },
      { id: "too_late", label: "Too late" },
      { id: "wrong_person", label: "Wrong person" },
    ],
  },
  pmf: {
    id: "pmf",
    question: "How would you feel if you could no longer use Orbit?",
    why: "You've been using it for a few weeks.",
    options: [
      { id: "very", label: "Very disappointed" },
      { id: "somewhat", label: "Somewhat disappointed" },
      { id: "not_disappointed", label: "Not disappointed" },
    ],
  },
  // Asked inside the cancellation flow, never as a floating prompt; see `CANCEL_REASONS`.
  cancellation: {
    id: "cancellation",
    question: "What's the main reason you're cancelling?",
    why: "One tap, and it's the most useful thing you can tell us.",
    options: [
      { id: "too_expensive", label: "It costs too much" },
      { id: "not_using", label: "I'm not using it" },
      { id: "missing_feature", label: "It's missing something I need" },
      { id: "privacy", label: "I'm not comfortable with my data" },
      { id: "season_over", label: "My search or season is over" },
      { id: "other", label: "Something else" },
    ],
  },
};

/** The floating prompt never asks more often than this, whatever is eligible. */
export const SURVEY_COOLDOWN_DAYS = 14;

/** The one question id every survey uses; a second question would get its own (letters and underscores only: the event schema bounds it). */
export const SURVEY_QUESTION_ID = "primary";

export function isSurveyId(value: unknown): value is SurveyId {
  return typeof value === "string" && value in SURVEY_DEFINITIONS;
}

/** Whether `answer` is one of the survey's own options. */
export function isValidAnswer(id: SurveyId, answer: unknown): answer is string {
  return typeof answer === "string" && SURVEY_DEFINITIONS[id].options.some((o) => o.id === answer);
}
