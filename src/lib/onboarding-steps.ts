/**
 * The first-run flow's steps, in the one place both the client controller and the server
 * action that persists `user_settings.onboarding_step` read them.
 *
 * Pure — no React, no icons — so `src/actions/onboarding.ts` can validate against it
 * without pulling a client component into the server bundle.
 */

export const ONBOARDING_STEPS = [
  "welcome",
  "linkedin",
  "highlights",
  "add-people",
  "ai-key",
  "capture",
  "manual",
  "import",
  "triage",
  "done",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * A `Record` rather than a hand-kept set, so a step added to the tuple above without a
 * decision here is a compile error. The tour's old allowlist was a set behind a "keep in
 * sync" comment and silently rejected its `reminders` step, so a refresh there resumed two
 * steps back.
 */
const STEP_IDS: Record<OnboardingStep, true> = {
  welcome: true,
  linkedin: true,
  highlights: true,
  "add-people": true,
  "ai-key": true,
  capture: true,
  manual: true,
  import: true,
  triage: true,
  done: true,
};

export function isOnboardingStep(value: string | null | undefined): value is OnboardingStep {
  return value != null && Object.hasOwn(STEP_IDS, value);
}

/**
 * Where a stored step resumes. Anything unrecognised — including the retired tour's ids
 * (`dashboard`, `contacts`, …) still stored for accounts mid-tour when this shipped —
 * starts over at the welcome rather than guessing.
 */
export function resumeStep(value: string | null | undefined): OnboardingStep {
  return isOnboardingStep(value) ? value : "welcome";
}

/** The five nodes the progress orbit draws. Branch steps share their stage's node. */
export const ONBOARDING_STAGES = ["welcome", "linkedin", "highlights", "people", "done"] as const;
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

export const STAGE_LABELS: Record<OnboardingStage, string> = {
  welcome: "Welcome",
  linkedin: "LinkedIn export",
  highlights: "What Orbit does",
  people: "Your people",
  done: "Done",
};

export function stageOf(step: OnboardingStep): OnboardingStage {
  switch (step) {
    case "welcome":
    case "linkedin":
    case "highlights":
    case "done":
      return step;
    default:
      return "people";
  }
}

/** Steps where the account has reached "add people" — the old wizard's offer point. */
export function isPeopleStep(step: OnboardingStep): boolean {
  return stageOf(step) === "people";
}
