/**
 * The first-run flow's steps and paths, in the one place the client controller, the server
 * action that persists `user_settings.onboarding_step`, and the smoke all read them.
 *
 * Pure — no React, no icons — so `src/actions/onboarding.ts` can validate against it
 * without pulling a client component into the server bundle.
 *
 * Two paths: the **guided tour** (welcome → connect → a coach rail over the real pages) and
 * **quick setup**, the default: welcome → one real person (capture, or by hand) → the first
 * win, that person and the follow-up Orbit set. Everything that waits on something else — a
 * Google or Outlook connection, a LinkedIn export, the tour of every page — is offered from
 * the first win rather than standing between someone and it.
 *
 * The tuple is in the order a person travels, because the slide transition reads direction
 * from it (`stepDirection`). Retired ids sit at the end: they still parse, never render.
 */

export const ONBOARDING_STEPS = [
  "welcome",
  "people",
  "capture",
  "manual",
  "import",
  "triage",
  "first-win",
  "connect",
  "overview",
  "launch",
  "linkedin",
  "ai-key",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_PATHS = ["tour", "quick"] as const;
export type OnboardingPath = (typeof ONBOARDING_PATHS)[number];

/**
 * A `Record` rather than a hand-kept set, so a step added to the tuple above without a
 * decision here is a compile error. The old tour's allowlist was a set behind a "keep in
 * sync" comment and silently rejected its `reminders` step, so a refresh there resumed two
 * steps back.
 */
const STEP_IDS: Record<OnboardingStep, true> = {
  welcome: true,
  linkedin: true,
  import: true,
  "ai-key": true,
  connect: true,
  people: true,
  capture: true,
  manual: true,
  triage: true,
  "first-win": true,
  overview: true,
  launch: true,
};

const PATH_IDS: Record<OnboardingPath, true> = { tour: true, quick: true };

export function isOnboardingStep(value: string | null | undefined): value is OnboardingStep {
  return value != null && Object.hasOwn(STEP_IDS, value);
}

export function isOnboardingPath(value: string | null | undefined): value is OnboardingPath {
  return value != null && Object.hasOwn(PATH_IDS, value);
}

/**
 * The two main lines. Quick setup goes from the welcome straight to capturing one real person,
 * then shows what that made (`first-win`); the tour shows them around. On quick, `people`
 * (every way to add someone), `manual`, `import` and `triage` branch off the capture node, and
 * `connect` and `overview` (the paged tour of features) branch off the first win.
 *
 * `linkedin` and `ai-key` left both lines in Sprint B: the LinkedIn export is a dashboard card
 * now, and Free includes AI. Their ids stay in ONBOARDING_STEPS so a stored step still parses,
 * and `resumeStep` moves it onto the path's first step.
 */
export const PATH_STAGES = {
  tour: ["welcome", "connect", "launch"],
  quick: ["welcome", "capture", "first-win"],
} as const satisfies Record<OnboardingPath, readonly OnboardingStep[]>;

export type OnboardingStage = (typeof PATH_STAGES)[OnboardingPath][number];

export const RETIRED_STEPS: readonly OnboardingStep[] = ["linkedin", "ai-key"];

export const STAGE_LABELS: Record<OnboardingStage, string> = {
  welcome: "Welcome",
  capture: "Your first person",
  "first-win": "All set",
  connect: "Your accounts",
  launch: "The tour",
};

/** Which progress node a step lights. Branch steps share their parent's node. */
export function stageOf(step: OnboardingStep, path: OnboardingPath): OnboardingStage {
  switch (step) {
    case "welcome":
    case "launch":
      return step;
    case "connect":
      // A main step on the tour; on quick setup a branch off the first win.
      return path === "tour" ? "connect" : "first-win";
    case "people":
    case "capture":
    case "manual":
    case "triage":
    case "import":
      return "capture";
    case "first-win":
    case "overview":
      return "first-win";
    case "linkedin":
    case "ai-key":
      // Retired: `resumeStep` never lands here. Welcome is the harmless answer.
      return "welcome";
  }
}

export function stepAllowedOnPath(step: OnboardingStep, path: OnboardingPath): boolean {
  if (RETIRED_STEPS.includes(step)) return false;
  if (step === "welcome" || step === "connect") return true;
  return path === "quick" ? step !== "launch" : step === "launch";
}

/** What decides which setup steps an account can skip outright. */
export type StepFacts = {
  /** At least one of Google / Microsoft is configured on this deployment. */
  connectConfigured: boolean;
};

/** The main line with the skippable steps removed. */
export function mainLine(path: OnboardingPath, facts: StepFacts): OnboardingStage[] {
  return (PATH_STAGES[path] as readonly OnboardingStage[]).filter((step) => step !== "connect" || facts.connectConfigured);
}

/** The first step after welcome on this path's main line. */
export function firstStep(path: OnboardingPath, facts: StepFacts): OnboardingStage {
  return nextStep("welcome", path, facts) ?? "welcome";
}

/**
 * The main-line step after `step`, or null at the end. Branch steps map to their node.
 *
 * Positions come from the path's FULL order, not the skipped line: the moment a key is
 * saved on the key step, `mainLine` no longer contains "ai-key", and looking the current
 * step up there would find nothing and strand the person on it.
 */
export function nextStep(
  step: OnboardingStep,
  path: OnboardingPath,
  facts: StepFacts,
): OnboardingStage | null {
  const full = PATH_STAGES[path] as readonly OnboardingStage[];
  const line = new Set(mainLine(path, facts));
  const at = full.indexOf(stageOf(step, path));
  for (let i = at + 1; i < full.length; i++) if (line.has(full[i])) return full[i];
  return null;
}

/** The main-line step before `step`, or null at the start. */
export function prevStep(
  step: OnboardingStep,
  path: OnboardingPath,
  facts: StepFacts,
): OnboardingStage | null {
  const full = PATH_STAGES[path] as readonly OnboardingStage[];
  const line = new Set(mainLine(path, facts));
  const at = full.indexOf(stageOf(step, path));
  for (let i = at - 1; i >= 0; i--) if (line.has(full[i])) return full[i];
  return null;
}

/**
 * Where a stored step resumes. Anything unrecognised — including the retired tour's and
 * wizard's ids still stored for accounts mid-flow when this shipped — starts over at the
 * welcome rather than guessing. So does a step that is not on the stored path.
 */
export function resumeStep(
  value: string | null | undefined,
  path: string | null | undefined,
  facts: StepFacts = { connectConfigured: true },
): OnboardingStep {
  if (!isOnboardingStep(value) || value === "welcome") return "welcome";
  if (!isOnboardingPath(path)) return "welcome";
  if (stepAllowedOnPath(value, path)) return value;
  // A step this path no longer has (a stored LinkedIn or AI-key screen, or the tour's old
  // import branch) moves on, never back to the start.
  return RETIRED_STEPS.includes(value) || value === "import" ? firstStep(path, facts) : "welcome";
}

/** Direction of travel between two steps, for the slide transition. */
export function stepDirection(from: OnboardingStep, to: OnboardingStep): 1 | -1 {
  return ONBOARDING_STEPS.indexOf(to) >= ONBOARDING_STEPS.indexOf(from) ? 1 : -1;
}

/**
 * Whether first-run guidance may show — the dashboard's setup checklist, the LinkedIn export
 * card, the no-key alert: setup was finished or skipped (`onboarding_completed_at`), or the
 * person saw it and went elsewhere (`onboarding_step` is set the moment the stage mounts, and
 * nothing renders it outside `/onboarding`). The second half is the fix: someone who opened
 * setup and wandered off never got the completion stamp, and so lost all three for good.
 *
 * Deliberately not a write: stamping completion on the way out would count everyone who left
 * at the welcome as "onboarded" in the admin funnel.
 */
export function onboardingSeen(settings: {
  onboardingCompletedAt?: Date | string | null;
  onboardingStep?: string | null;
}): boolean {
  return settings.onboardingCompletedAt != null || settings.onboardingStep != null;
}
