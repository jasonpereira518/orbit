import { track } from "@/lib/product-events";
import { eventId } from "@/lib/product-event-ids";
import { PATH_STAGES, RETIRED_STEPS, isOnboardingStep, stageOf, type OnboardingPath } from "@/lib/onboarding-steps";
import { TOUR_STOP_IDS_LIST } from "@/lib/tour/tour-stops";

/**
 * `onboarding_*` product events. Pure of the database: the actions read the previous step
 * (the one the person is leaving) and hand it here, so the rules live in one testable place.
 *
 * `onboarding_step_completed` means the step the person LEFT, going forward. The actions
 * persist the step they are arriving at, so the previous value in the row is the one that was
 * finished. Going back finishes nothing, and a step finished before (a replayed tour, back
 * then forward) lands on the same deterministic id and is dropped by the insert.
 */

/** A step or stop id as an event value: `/^[a-z_]{1,32}$/`. "ai-key" -> "ai_key", "reminders.done" -> "reminders_done". */
export function stepEventValue(step: string): string {
  return step.toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
}

export function trackOnboardingPathChosen(userId: string, path: OnboardingPath): void {
  // One per account, ever: replaying onboarding and choosing again is not a second first choice.
  track("onboarding_path_chosen", { path }, { userId, id: eventId("onboarding_path_chosen", userId) });
}

function trackStepCompleted(userId: string, path: OnboardingPath, step: string): void {
  const value = stepEventValue(step);
  if (!value) return;
  track(
    "onboarding_step_completed",
    { path, step: value },
    { userId, id: eventId("onboarding_step_completed", userId, path, value) }
  );
}

/**
 * Moving to `next` finishes the stage `previous` belongs to (`stageOf`) when `next` is in a later
 * stage, and the event names that stage. A side step counts toward its stage: adding someone by
 * hand, or importing LinkedIn, then reaching the first win finishes "capture" just as the notes
 * box does. Moving within a stage, going back, or a retired id resumed from storage finishes
 * nothing.
 */
export function trackOnboardingStepAdvance(
  userId: string,
  path: string | null | undefined,
  previous: string | null | undefined,
  next: string
): void {
  if (path !== "tour" && path !== "quick") return;
  if (!previous || previous === next) return;
  if (!isOnboardingStep(previous) || !isOnboardingStep(next)) return;
  if (RETIRED_STEPS.includes(previous) || RETIRED_STEPS.includes(next)) return;
  const stages: readonly string[] = PATH_STAGES[path];
  const from = stages.indexOf(stageOf(previous, path));
  const to = stages.indexOf(stageOf(next, path));
  if (from < 0 || to < 0 || to <= from) return;
  trackStepCompleted(userId, path, stages[from]!);
}

/** The in-app tour: a null previous stop means the first stop. */
export function trackTourStopAdvance(userId: string, previous: string | null | undefined, next: string): void {
  const stops: readonly string[] = TOUR_STOP_IDS_LIST;
  const from = stops.indexOf(previous ?? stops[0]!);
  const to = stops.indexOf(next);
  if (from < 0 || to < 0 || to <= from) return;
  trackStepCompleted(userId, "tour", stops[from]!);
}
