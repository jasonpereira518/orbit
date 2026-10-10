/**
 * The first-run flow's steps and paths, in the one place the client controller, the server
 * action that persists `user_settings.onboarding_step`, and the smoke all read them.
 *
 * Pure — no React, no icons — so `src/actions/onboarding.ts` can validate against it
 * without pulling a client component into the server bundle.
 *
 * Two paths: the **guided tour** (welcome → connect → a coach rail over the real pages) and
 * **quick setup** (welcome → your people → connect → a paged overview). People come first:
 * the person's own contacts are the easy win.
 */

export const ONBOARDING_STEPS = [
  "welcome",
  "linkedin",
  "import",
  "ai-key",
  "connect",
  "people",
  "capture",
  "manual",
  "triage",
  "overview",
  "launch",
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
 * The two main lines. Quick setup goes straight to the person's own people; the tour shows
 * them around. `linkedin` and `ai-key` left both lines (Sprint B): the LinkedIn export is a
 * dashboard card now, and Free includes AI. Their ids stay in ONBOARDING_STEPS so a stored
 * step still parses, and `resumeStep` moves it onto the path's first step.
 */
export const PATH_STAGES = {
  tour: ["welcome", "connect", "launch"],
  quick: ["welcome", "people", "connect", "overview"],
} as const satisfies Record<OnboardingPath, readonly OnboardingStep[]>;

export type OnboardingStage = (typeof PATH_STAGES)[OnboardingPath][number];

export const RETIRED_STEPS: readonly OnboardingStep[] = ["linkedin", "ai-key"];

export const STAGE_LABELS: Record<OnboardingStage, string> = {
  welcome: "Welcome",
  people: "Your people",
  connect: "Your accounts",
  overview: "What Orbit does",
  launch: "The tour",
};

/** Which progress node a step lights. Branch steps share their parent's node. */
export function stageOf(step: OnboardingStep, path: OnboardingPath): OnboardingStage {
  void path;
  switch (step) {
    case "welcome":
    case "connect":
    case "overview":
    case "launch":
      return step;
    case "people":
    case "capture":
    case "manual":
    case "triage":
    case "import":
      return "people";
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
