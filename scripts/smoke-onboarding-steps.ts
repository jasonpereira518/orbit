/**
 * The first-run flow's step ids: what the server accepts, where a stored step resumes on
 * each path, which progress node each step lights, and which setup steps the facts skip.
 *
 * The old tour's allowlist silently rejected one of its own steps, so a refresh there
 * resumed two steps back. Every step here must round-trip, and a retired tour or wizard id
 * stored for an account mid-flow when the flows merged must restart cleanly.
 *
 * Run: npx tsx scripts/smoke-onboarding-steps.ts
 */
import {
  ONBOARDING_PATHS,
  ONBOARDING_STEPS,
  PATH_STAGES,
  RETIRED_STEPS,
  STAGE_LABELS,
  firstStep,
  isOnboardingPath,
  isOnboardingStep,
  mainLine,
  nextStep,
  prevStep,
  resumeStep,
  stageOf,
  stepAllowedOnPath,
} from "../src/lib/onboarding-steps";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const ALL = { connectConfigured: true };
const BARE = { connectConfigured: false };

function main() {
  console.log("Onboarding steps…");

  console.log("\nevery step round-trips on a path that allows it");
  for (const step of ONBOARDING_STEPS) {
    check(`"${step}" is accepted`, isOnboardingStep(step));
    if (RETIRED_STEPS.includes(step)) continue;
    const path = ONBOARDING_PATHS.find((p) => stepAllowedOnPath(step, p));
    check(`"${step}" is allowed on some path`, path != null);
    if (step !== "welcome" && path) {
      check(`"${step}" resumes as itself on ${path}`, resumeStep(step, path) === step);
    }
  }

  console.log("\nanything else restarts at welcome");
  for (const legacy of ["dashboard", "contacts", "recruiters", "reminders", "intro", "review", "add-people", "highlights", "done", "", "toString", "__proto__"]) {
    check(`"${legacy}" is rejected`, !isOnboardingStep(legacy));
    check(`"${legacy}" resumes at welcome`, resumeStep(legacy, "tour") === "welcome");
  }
  check("null resumes at welcome", resumeStep(null, "quick") === "welcome");
  check("a step with no path resumes at welcome", resumeStep("connect", null) === "welcome");
  check("an off-path step resumes at welcome", resumeStep("overview", "tour") === "welcome");
  check("launch is off the quick path", resumeStep("launch", "quick") === "welcome");
  check("bogus paths are rejected", !isOnboardingPath("wizard") && !isOnboardingPath("__proto__"));

  console.log("\nprogress stages");
  for (const path of ONBOARDING_PATHS) {
    for (const stage of PATH_STAGES[path]) {
      check(`${path}: "${stage}" has a label`, typeof STAGE_LABELS[stage] === "string" && STAGE_LABELS[stage].length > 0);
      check(`${path}: "${stage}" lights itself`, stageOf(stage, path) === stage);
    }
  }
  for (const step of ["capture", "manual", "triage"] as const) {
    check(`"${step}" lights the people node`, stageOf(step, "quick") === "people");
  }
  check("import lights people", stageOf("import", "quick") === "people");
  check("quick goes people first", mainLine("quick", ALL).join(">") === "welcome>people>connect>overview");
  check("the tour is welcome, connect, launch", mainLine("tour", ALL).join(">") === "welcome>connect>launch");
  check("no configured provider skips connect", !mainLine("tour", BARE).includes("connect") && !mainLine("quick", BARE).includes("connect"));
  check("quick starts on people", firstStep("quick", ALL) === "people");
  check("the tour starts on connect, or launch without providers", firstStep("tour", ALL) === "connect" && firstStep("tour", BARE) === "launch");
  check("quick: people → connect → overview", nextStep("people", "quick", ALL) === "connect" && nextStep("connect", "quick", ALL) === "overview");
  check("quick, bare: people goes straight to the overview", nextStep("people", "quick", BARE) === "overview");
  check("tour: after connect comes the launch", nextStep("connect", "tour", ALL) === "launch");
  check("the last step has no next", nextStep("launch", "tour", ALL) === null && nextStep("overview", "quick", ALL) === null);
  check("welcome has no previous", prevStep("welcome", "tour", ALL) === null);
  check("a branch step's neighbours are its node's", nextStep("capture", "quick", ALL) === "connect" && prevStep("triage", "quick", ALL) === "welcome");
  for (const retired of RETIRED_STEPS) {
    check(`a stored "${retired}" resumes on quick's first step`, resumeStep(retired, "quick", ALL) === "people");
    check(`a stored "${retired}" resumes on the tour's first step`, resumeStep(retired, "tour", ALL) === "connect");
    check(`a stored "${retired}" resumes on launch when nothing is configured`, resumeStep(retired, "tour", BARE) === "launch");
  }
  check("a stored tour import resumes on the tour's first step", resumeStep("import", "tour", ALL) === "connect");
  check("a stored quick import still resumes as itself", resumeStep("import", "quick", ALL) === "import");
  check("STAGE_LABELS covers exactly the stages", Object.keys(STAGE_LABELS).sort().join(",") === "connect,launch,overview,people,welcome");

  console.log("\nAll onboarding step checks passed.");
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error("\nFAILED:", e);
  process.exit(1);
}
