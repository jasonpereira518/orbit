/**
 * The first-run flow's step ids: what the server accepts, where a stored step resumes, and
 * which progress node each step lights.
 *
 * The old tour's allowlist silently rejected one of its own steps, so a refresh there
 * resumed two steps back. Every step here must round-trip, and a retired tour id stored for
 * an account mid-tour when the flows merged must restart cleanly rather than crash or guess.
 *
 * Run: npx tsx scripts/smoke-onboarding-steps.ts
 */
import {
  ONBOARDING_STAGES,
  ONBOARDING_STEPS,
  isOnboardingStep,
  isPeopleStep,
  resumeStep,
  stageOf,
} from "../src/lib/onboarding-steps";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function main() {
  console.log("Onboarding steps…");

  console.log("\nevery step round-trips");
  for (const step of ONBOARDING_STEPS) {
    check(`"${step}" is accepted and resumes as itself`, isOnboardingStep(step) && resumeStep(step) === step);
  }

  console.log("\nanything else restarts at welcome");
  for (const legacy of ["dashboard", "contacts", "recruiters", "reminders", "intro", "review", "", "toString", "__proto__"]) {
    check(`"${legacy}" is rejected`, !isOnboardingStep(legacy));
    check(`"${legacy}" resumes at welcome`, resumeStep(legacy) === "welcome");
  }
  check("null resumes at welcome", resumeStep(null) === "welcome");

  console.log("\nprogress stages");
  check("the orbit has five nodes", ONBOARDING_STAGES.length === 5);
  for (const step of ["ai-key", "capture", "manual", "import", "triage"] as const) {
    check(`"${step}" lights the people node`, stageOf(step) === "people" && isPeopleStep(step));
  }
  check("add-people is the people node", stageOf("add-people") === "people");
  check("linkedin is its own node, second", ONBOARDING_STAGES.indexOf(stageOf("linkedin")) === 1);
  check("welcome is not a people step", !isPeopleStep("welcome"));
  check("done is not a people step", !isPeopleStep("done"));

  console.log("\nAll onboarding step checks passed.");
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error("\nFAILED:", e);
  process.exit(1);
}
