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
import { readFileSync } from "node:fs";
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
  stepDirection,
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
  for (const step of ["people", "capture", "manual", "triage", "import"] as const) {
    check(`"${step}" lights the capture node on quick`, stageOf(step, "quick") === "capture");
  }
  check("on quick, connect and the overview light the first win", stageOf("connect", "quick") === "first-win" && stageOf("overview", "quick") === "first-win");
  check("on the tour, connect lights itself", stageOf("connect", "tour") === "connect");
  check("quick goes straight to one real person, then the first win, then About you", mainLine("quick", ALL).join(">") === "welcome>capture>first-win>about");
  check("…whatever is configured", mainLine("quick", BARE).join(">") === "welcome>capture>first-win>about");
  check("the tour is welcome, connect, launch", mainLine("tour", ALL).join(">") === "welcome>connect>launch");
  check("no configured provider skips the tour's connect", !mainLine("tour", BARE).includes("connect"));
  check("quick starts on capture", firstStep("quick", ALL) === "capture" && firstStep("quick", BARE) === "capture");
  check("the tour starts on connect, or launch without providers", firstStep("tour", ALL) === "connect" && firstStep("tour", BARE) === "launch");
  check("quick: capture → first win → About you, which ends it",
    nextStep("capture", "quick", ALL) === "first-win" && nextStep("first-win", "quick", ALL) === "about" && nextStep("about", "quick", ALL) === null);
  check("About you is quick setup's only: never before the first win, never on the tour",
    stepAllowedOnPath("about", "quick") && !stepAllowedOnPath("about", "tour") && !mainLine("tour", ALL).includes("about"));
  check("About you lights itself, resumes as itself, and goes back to the first win",
    stageOf("about", "quick") === "about" && resumeStep("about", "quick", ALL) === "about" && prevStep("about", "quick", ALL) === "first-win");
  check("a stored About you on the tour starts over", resumeStep("about", "tour", ALL) === "welcome");
  check("STAGE_LABELS.about", STAGE_LABELS.about === "About you");
  check("tour: after connect comes the launch", nextStep("connect", "tour", ALL) === "launch");
  check("the last step has no next", nextStep("launch", "tour", ALL) === null && nextStep("about", "quick", ALL) === null);
  check("welcome has no previous", prevStep("welcome", "tour", ALL) === null);
  check("a branch step's neighbours are its node's", nextStep("triage", "quick", ALL) === "first-win" && prevStep("triage", "quick", ALL) === "welcome");
  check("every way of adding someone leads to the first win",
    (["people", "triage", "capture", "manual", "import"] as const).every((b) => nextStep(b, "quick", ALL) === "first-win"));
  check("the first win's branches lead on to About you", nextStep("connect", "quick", ALL) === "about" && nextStep("overview", "quick", ALL) === "about");
  const flow = readFileSync("src/components/onboarding/onboarding-flow.tsx", "utf8");
  check("the flow renders the first win", /step === "first-win"/.test(flow));
  check("the flow opens the overview only from the first win", (flow.match(/goTo\(\s*["']overview["']\s*\)/g) ?? []).length <= 1);
  for (const retired of RETIRED_STEPS) {
    check(`a stored "${retired}" resumes on quick's first step`, resumeStep(retired, "quick", ALL) === "capture");
    check(`a stored "${retired}" resumes on the tour's first step`, resumeStep(retired, "tour", ALL) === "connect");
    check(`a stored "${retired}" resumes on launch when nothing is configured`, resumeStep(retired, "tour", BARE) === "launch");
  }
  check("a stored tour import resumes on the tour's first step", resumeStep("import", "tour", ALL) === "connect");
  check("a stored quick import still resumes as itself", resumeStep("import", "quick", ALL) === "import");
  check("someone mid-way through the old quick path resumes where they were",
    resumeStep("people", "quick", ALL) === "people" && resumeStep("connect", "quick", ALL) === "connect" && resumeStep("overview", "quick", ALL) === "overview");
  check("the first win is quick setup's, never the tour's", resumeStep("first-win", "quick", ALL) === "first-win" && resumeStep("first-win", "tour", ALL) === "welcome");
  check("STAGE_LABELS covers exactly the stages", Object.keys(STAGE_LABELS).sort().join(",") === "about,capture,connect,first-win,launch,welcome");

  console.log("\nslides go the way a person travels");
  check("welcome → capture → first win slide forward", stepDirection("welcome", "capture") === 1 && stepDirection("capture", "first-win") === 1);
  check("the chooser and by-hand lead forward to the first win", stepDirection("people", "manual") === 1 && stepDirection("manual", "first-win") === 1);
  check("the first win's branches slide forward", stepDirection("first-win", "connect") === 1 && stepDirection("first-win", "overview") === 1);
  check("…and so does About you, from the first win or its branches", stepDirection("first-win", "about") === 1 && stepDirection("connect", "about") === 1 && stepDirection("overview", "about") === 1);
  check("the tour slides forward all the way", stepDirection("welcome", "connect") === 1 && stepDirection("connect", "launch") === 1);
  check("back from capture to welcome slides back", stepDirection("capture", "welcome") === -1);

  console.log("\nAll onboarding step checks passed.");
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error("\nFAILED:", e);
  process.exit(1);
}
