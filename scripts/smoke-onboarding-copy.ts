/**
 * Sprint B onboarding copy: capture is the recommended way to add people, "later" is a real
 * button, highlights say "Uses AI credits", and Settings explains Free's allowance.
 *
 * Run: npx tsx scripts/smoke-onboarding-copy.ts
 */
import { readFileSync } from "node:fs";
import { FREE_AI_EXPLAINER, freeAiExplainer } from "../src/lib/ai-access-copy";
import { PLAN_CONFIG } from "../src/lib/plans/plan-config";
import { applyPlanOverrides, limitRuleRow, parsePlanRules } from "../src/lib/plans/plan-overrides";

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
const captureFlow = readFileSync("src/components/capture/capture-flow.tsx", "utf8");
check("capture never opens on the meeting tab (recording lives on /meetings)",
  /const opened = initial === "meeting" \? "messy" : initial;/.test(captureFlow));
check("embedded capture hands off only a save it saw happen, never a stale saved job",
  /seenUnsavedRef\.current !== job\.id\) \{\s*clearCaptureJob\(\);\s*return;/.test(captureFlow));
const chapters = readFileSync("src/components/onboarding/highlights/chapters.ts", "utf8");
check("the ask chapter no longer says it runs on your key", !chapters.includes("Runs on the AI key you bring"));
check("the Settings explainer names both numbers",
  FREE_AI_EXPLAINER === "Free includes 50 AI credits a month and 25 to start. Add your own key to use AI with no limit", FREE_AI_EXPLAINER);
const raised = applyPlanOverrides(PLAN_CONFIG, parsePlanRules([limitRuleRow("free", "monthlyCredits", 80)]));
check("…and follows the effective plan table", freeAiExplainer(raised).startsWith("Free includes 80 AI credits a month"), freeAiExplainer(raised));
check("the highlights name the plan a locked line unlocks on", highlights.includes("unlockTagPlan("));

// Capture-first onboarding (R4, R2, R8): one thing to do on the welcome, a by-hand way in that
// still sets a follow-up when AI cannot run, and the first win shown back after the save.
const welcome = readFileSync("src/components/onboarding/steps/welcome-step.tsx", "utf8");
check("the welcome has one primary action: add someone you met", welcome.includes("Add someone you met") && (welcome.match(/<Button\s[^>]*size="lg"/g) ?? []).length === 1);
check("the tour is still one click, as a secondary link", welcome.includes("Show me around with example people first") && /variant="link"[\s\S]{0,120}onClick=\{onTour\}/.test(welcome));
check("the tour is no longer the recommended card", !/Recommended/.test(welcome));
check("skipping is offered on the welcome itself", welcome.includes("Skip for now"));
check("the credits line names both numbers from the live plan table", /planConfig\.free\.monthlyCredits/.test(welcome) && /FREE_STARTER_CREDITS/.test(welcome));
check("the capture step leads with the by-hand form when AI cannot run",
  /!hasApiKey && !notesAnyway[\s\S]{0,400}<ContactForm[^>]*followUpChoice/.test(captureStep), captureStep.slice(0, 200));
check("…and keeps a LinkedIn URL one click away", captureStep.includes("Paste the URL instead"));
check("…and offers a way out of the notes box when AI can run", captureStep.includes("Type their details instead") && captureStep.includes("Other ways to add people"));
const manual = readFileSync("src/components/onboarding/steps/manual-step.tsx", "utf8");
check("adding someone by hand sets a follow-up", /<ContactForm[^>]*followUpChoice/.test(manual));
const contactForm = readFileSync("src/components/contacts/contact-form.tsx", "utf8");
check("the contact form schedules the chosen follow-up after creating", /followUpChoice && followUpDays > 0[\s\S]{0,200}scheduleContactFollowUp\(c\.id, followUpDays\)/.test(contactForm));
const flow = readFileSync("src/components/onboarding/onboarding-flow.tsx", "utf8");
check("a saved first person goes on to the first win, not the feature overview", /advance\("capture"\)/.test(flow) && !/advance\("people"\)/.test(flow));
const firstWin = readFileSync("src/components/onboarding/steps/first-win-step.tsx", "utf8");
check("the first win names the date Orbit will remind them", firstWin.includes("Orbit will remind you on"));
check("…offers a follow-up when none was set", firstWin.includes("Want a nudge to stay in touch with"));
check("…and keeps its one motion still for reduced motion", /useReducedMotionConfig\(\)/.test(firstWin) && /initial=\{still \? false/.test(firstWin));
const capturePage = readFileSync("src/components/capture/capture-flow.tsx", "utf8");
check("/capture offers adding someone by hand while AI cannot run, never from inside onboarding",
  /manualHref=\{onSaved \? null : "\/contacts\/new\?quick=1"\}/.test(capturePage));

// The About you step: skippable on every screen, never waits on the self-lookup, and only a
// confident lookup prefills or is sent to the save.
const about = readFileSync("src/components/onboarding/steps/about-step.tsx", "utf8");
check("the stage renders the About you step", /step === "about" && \([\s\S]{0,400}<AboutStep/.test(flow));
check("'Skip for now' is a Button that skips without saving", /<Button[^>]*onClick=\{onSkip\}[^>]*>\s*Skip for now/.test(about));
check("there is a no-LinkedIn way through", about.includes("I don’t use LinkedIn"));
check("an unconfirmed lookup says so", about.includes("We couldn’t confirm this is you"));
check("the lookup is a fetch to the route, never awaited",
  /void fetch\("\/api\/onboarding\/self-lookup"/.test(about) && !/await fetch\("\/api\/onboarding\/self-lookup"/.test(about));
check("the step imports no lookup server action",
  !/import[^;]*lookUp[^;]*from "@\/actions\//.test(about) && !readFileSync("src/actions/about-you.ts", "utf8").includes("lookUpSelfForUser"));
check("Field chips wait for an aim (a field with no aim is not saved)",
  /label="Field"[\s\S]{0,200}disabled=\{!aim\}/.test(about) && /if \(!next\) setField\(null\)/.test(about));
check("only a confident lookup becomes the prefill", /status === "confident" \? lookup\.prefill : null/.test(about));
const kit = readFileSync("src/components/onboarding/onboarding-ui.tsx", "utf8");
check("chips are toggle buttons", /<button[\s\S]{0,120}aria-pressed=/.test(kit) && /<ToggleGroup\s+label="Your aim"/.test(about));
check("the confirm row is majors for students, the headline for people already working",
  /majorsRow \? \([\s\S]{0,120}Your major\(s\)[\s\S]{0,600}What you do now/.test(about) && about.includes("asksForMajors(aim)"));
check("'When' is a segmented switch", /label="When"\s+look="segment"/.test(about));
check("dream orgs take companies, schools and organizations, with suggestions",
  about.includes("Dream companies &amp; schools") && about.includes("Companies, schools or organizations · up to ${MAX_COMPANIES}") && /<OrgCombobox\s+id="about-company"/.test(about));
check("the URL field has a visible label", /<Field[^>]*label="Your LinkedIn profile"/.test(about));

// The visual revision: path cards say how long each path takes, the mark replaces the app
// logo inside onboarding only, and it moves by CSS (stopped by the reduced-motion clamp).
check("the old 'about a minute' line is gone", !/About a minute/i.test(welcome));
const launch = readFileSync("src/components/onboarding/steps/launch-step.tsx", "utf8");
check("onboarding uses OnboardingMark, not OrbitLogo",
  [flow, welcome, launch, firstWin].every((src) => src.includes("<OnboardingMark") && !src.includes("OrbitLogo")));
const mark = readFileSync("src/components/onboarding/onboarding-mark.tsx", "utf8");
check("the mark's moon is a CSS rotation, not SMIL", !/<animate/.test(mark) && /animate-\[spin_5s_linear_infinite\]/.test(mark));
check("the mark is decorative", /aria-hidden/.test(mark));
check("the goals chapter comes first", /HIGHLIGHT_CHAPTERS: HighlightChapter\[\] = \[[\s\S]{0,300}id: "goals"/.test(chapters));
const dashboard = readFileSync("src/components/dashboard/dashboard-sections.tsx", "utf8");
check("the setup checklist asks for a goal when none is set", /id: "about",\s*label: "Tell Orbit what you’re going for"/.test(dashboard));

// Combined with About you: it follows the first win and finishes setup; the welcome keeps one
// primary action and says how long each route takes.
check("the first win continues to About you", /onDone=\{\(\) => advance\("first-win"\)\}/.test(flow) && firstWin.includes("Continue"));
check("About you, done or skipped, finishes setup", /<AboutStep[\s\S]{0,300}onNext=\{\(\) => leave\(true\)\}[\s\S]{0,80}onSkip=\{\(\) => leave\(true\)\}/.test(flow));
check("the welcome says how long each route takes", welcome.includes("About 2 minutes") && welcome.includes("About 5 minutes"));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nonboarding-copy: ok");
process.exit(0);
