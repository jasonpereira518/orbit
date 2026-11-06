/**
 * Pins the micro-survey rules: which survey is due when, that silence is the default, that
 * answers are closed choices, and that the actions record exactly the events the analytics
 * plan reads.
 *
 * Run: npx tsx scripts/smoke-surveys.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { eventSchemas } from "../src/lib/product-event-schemas";
import { FLOATING_SURVEYS, chooseSurvey, loadSurveyFacts, type SurveyFacts } from "../src/lib/survey-eligibility";
import { SURVEY_DEFINITIONS, SURVEY_COOLDOWN_DAYS, isSurveyId, isValidAnswer } from "../src/lib/surveys";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const DAY = 86_400_000;
const now = new Date("2026-10-18T12:00:00Z");
const base = (): SurveyFacts => ({
  ageMs: 3 * DAY, internal: false, lastShownAt: null, settled: new Set(), activated: false,
  firstSavedCaptureAt: null, savedCaptures: 0, firstCompletionAt: null, completions: 0,
});
const pick = (patch: Partial<SurveyFacts>) => chooseSurvey({ ...base(), ...patch }, now);

run(async () => {
  console.log("definitions");
  for (const def of Object.values(SURVEY_DEFINITIONS)) {
    check(`${def.id}: every option is a closed id the event schema accepts`, def.options.every((o) => /^[a-z_]{1,32}$/.test(o.id)));
    check(`${def.id}: the event schema accepts a real answer`, eventSchemas.survey_answered.safeParse({ survey_id: def.id, question_id: "primary", answer: def.options[0]!.id }).success);
  }
  check("an answer must be one of the survey's own options", isValidAnswer("pmf", "very") && !isValidAnswer("pmf", "yes") && !isValidAnswer("pmf", "a free text answer"));
  check("an unknown survey id is refused", !isSurveyId("pmf2") && isSurveyId("pmf"));

  console.log("\nsilence is the default");
  check("a new account is asked nothing", pick({}) === null);
  check("internal accounts are never asked", pick({ internal: true, ageMs: 25 * DAY, activated: true }) === null);
  check("nothing within the cooldown of the last prompt", pick({ ageMs: 25 * DAY, activated: true, lastShownAt: new Date(now.getTime() - (SURVEY_COOLDOWN_DAYS - 1) * DAY) }) === null);
  check("and it may ask again after", pick({ ageMs: 25 * DAY, activated: true, lastShownAt: new Date(now.getTime() - (SURVEY_COOLDOWN_DAYS + 1) * DAY) }) === "pmf");
  check("a survey already answered or dismissed is not repeated", pick({ ageMs: 25 * DAY, activated: true, settled: new Set(["pmf"]) }) === null);
  check("the cancellation survey is never floated", !FLOATING_SURVEYS.includes("cancellation"));

  console.log("\neach survey waits for its moment");
  const mins = (m: number) => new Date(now.getTime() - m * 60_000);
  check("first capture: not while the review card is still open", pick({ savedCaptures: 1, firstSavedCaptureAt: mins(1) }) === null);
  check("first capture: a few minutes later", pick({ savedCaptures: 1, firstSavedCaptureAt: mins(10) }) === "post_first_capture");
  check("first capture: not the second capture", pick({ savedCaptures: 2, firstSavedCaptureAt: mins(10) }) === null);
  check("first capture: not days afterwards", pick({ savedCaptures: 1, firstSavedCaptureAt: new Date(now.getTime() - 3 * DAY) }) === null);
  check("first follow-up completed: within hours", pick({ completions: 1, firstCompletionAt: mins(30) }) === "followup_useful");
  check("first follow-up completed: not the fifth", pick({ completions: 5, firstCompletionAt: mins(30) }) === null);
  check("day 7, not activated: asked", pick({ ageMs: 7 * DAY, activated: false }) === "day7_not_activated");
  check("day 7, activated: not asked", pick({ ageMs: 7 * DAY, activated: true }) === null);
  check("day 12, not activated: too late to ask", pick({ ageMs: 12 * DAY, activated: false }) === null);
  check("week 3-4, activated: the PMF question", pick({ ageMs: 24 * DAY, activated: true }) === "pmf");
  check("week 3-4, not activated: not the PMF question", pick({ ageMs: 24 * DAY, activated: false }) === null);
  check("the most recent action wins when two are due", pick({ completions: 1, firstCompletionAt: mins(30), savedCaptures: 1, firstSavedCaptureAt: mins(40) }) === "followup_useful");

  console.log("\nthe loader reads a real account");
  const db = await getDb();
  const U = "smoke-survey-user";
  await db.execute(sql`DELETE FROM product_events WHERE user_id = ${U}`);
  await db.execute(sql`DELETE FROM user_settings WHERE user_id = ${U}`);
  await db.execute(sql`INSERT INTO user_settings (user_id, created_at) VALUES (${U}, ${new Date(Date.now() - 8 * DAY)})`);
  const facts = await loadSurveyFacts(U, new Date());
  check("a week-old account with nothing done reads as not activated", facts !== null && !facts.activated && facts.ageMs > 7 * DAY);
  check("and is due the day-7 survey", facts !== null && chooseSurvey(facts, new Date()) === "day7_not_activated");
  await db.execute(sql`INSERT INTO product_events (id, name, surface, actor, user_id, properties) VALUES (gen_random_uuid(), 'survey_dismissed', 'web', 'user', ${U}, '{"survey_id":"day7_not_activated"}')`);
  const after = await loadSurveyFacts(U, new Date());
  check("a dismissal is remembered", after !== null && after.settled.has("day7_not_activated") && chooseSurvey(after, new Date()) === null);
  await db.execute(sql`DELETE FROM product_events WHERE user_id = ${U}`);
  await db.execute(sql`DELETE FROM user_settings WHERE user_id = ${U}`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll survey checks passed.");
});
