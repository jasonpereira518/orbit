/**
 * Sprint B onboarding copy: capture is the recommended way to add people, "later" is a real
 * button, highlights say "Uses AI credits", and Settings explains Free's allowance.
 *
 * Run: npx tsx scripts/smoke-onboarding-copy.ts
 */
import { readFileSync } from "node:fs";
import { FREE_AI_EXPLAINER } from "../src/lib/ai-access-copy";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const people = readFileSync("src/components/onboarding/steps/people-step.tsx", "utf8");
check("capture is marked recommended", /id: "capture",[\s\S]{0,300}recommended: true/.test(people));
check("'later' is a Button, not a text link", /<Button[^>]*onClick=\{onLater\}/.test(people));
check("the step no longer calls itself the last step", !/eyebrow="Last step"/.test(people));
const highlights = readFileSync("src/components/onboarding/steps/highlights-step.tsx", "utf8");
check("the highlight tag says Uses AI credits", highlights.includes("Uses AI credits") && !highlights.includes("Needs AI key"));
check("the overview subtitle no longer says tags show what needs a key", !highlights.includes("needs a key") && highlights.includes("uses AI credits"));
// Onboarding capture runs on the durable capture job, like /capture, so a reload resumes the
// review instead of dropping it: the page hands the open job down, the step renders CaptureFlow.
const onboardingPage = readFileSync("src/app/(clerk)/(app)/onboarding/page.tsx", "utf8");
const captureStep = readFileSync("src/components/onboarding/steps/capture-step.tsx", "utf8");
check("the onboarding page loads the open capture job", onboardingPage.includes("getActiveCaptureJob()"));
check("the onboarding capture step runs on CaptureFlow, not the job-less panel",
  /CaptureFlow/.test(captureStep) && /initialJob=/.test(captureStep) && !captureStep.includes("BulkNotesPanel"));
const chapters = readFileSync("src/components/onboarding/highlights/chapters.ts", "utf8");
check("the ask chapter no longer says it runs on your key", !chapters.includes("Runs on the AI key you bring"));
check("the Settings explainer names both numbers",
  FREE_AI_EXPLAINER === "Free includes 10 AI credits a month and 25 to start. Add your own key to use AI with no limit", FREE_AI_EXPLAINER);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nonboarding-copy: ok");
process.exit(0);
