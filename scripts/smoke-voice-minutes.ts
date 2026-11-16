/**
 * Cosmo's minutes (src/lib/voice/policy.ts voiceCallLength + the plan table): every plan has an
 * allowance, an operator can change it, and a new call is cut to what's left of the month and of
 * today's shared budget, or refused saying which ran out. Pure: the DB sum is in smoke-orbit-voice.
 */
import { checker } from "./smoke/check";
import { PLAN_CONFIG, PLANS } from "../src/lib/plans/plan-config";
import { applyPlanOverrides, LIMIT_FIELDS, limitOf } from "../src/lib/plans/plan-overrides";
import { VOICE_DURATION_SECONDS, VOICE_MIN_CALL_SECONDS, voiceCallLength } from "../src/lib/voice/policy";
import { DEFAULT_VOICE_CONFIG, voiceConfigSchema } from "../src/lib/voice/config";

const t = checker();
t.check("every plan has Cosmo minutes", PLANS.every((p) => PLAN_CONFIG[p].speech.assistantSeconds > 0));
t.check("Free 10, Pro 60, Max and Lifetime 180", [600, 3600, 10800, 10800].join() === PLANS.map((p) => PLAN_CONFIG[p].speech.assistantSeconds).join());
t.check("an operator can change them", LIMIT_FIELDS.includes("speech.assistantSeconds"));
const changed = applyPlanOverrides(PLAN_CONFIG, { features: {}, limits: { free: { "speech.assistantSeconds": 120 } } } as never);
t.check("a plan rule applies to that plan only", limitOf(changed.free, "speech.assistantSeconds") === 120 && changed.orbit.speech.assistantSeconds === 3600);
t.check("the code table is never mutated", PLAN_CONFIG.free.speech.assistantSeconds === 600);

const plenty = voiceCallLength({ monthLeft: 3600, budgetLeft: 36000 });
t.check("plenty left: the normal call cap", "seconds" in plenty && plenty.seconds === VOICE_DURATION_SECONDS && !plenty.endsEarly);
const short = voiceCallLength({ monthLeft: 125.7, budgetLeft: 36000 });
t.check("little left: the call ends when the month's minutes do", "seconds" in short && short.seconds === 125 && short.endsEarly);
const budget = voiceCallLength({ monthLeft: 3600, budgetLeft: 200 });
t.check("today's shared budget cuts it too", "seconds" in budget && budget.seconds === 200 && budget.endsEarly);
t.check("month used up: refused for the allowance", JSON.stringify(voiceCallLength({ monthLeft: VOICE_MIN_CALL_SECONDS - 1, budgetLeft: 36000 })) === '{"refused":"allowance"}');
t.check("budget used up: refused for the budget", JSON.stringify(voiceCallLength({ monthLeft: 3600, budgetLeft: -50 })) === '{"refused":"budget"}');
t.check("the daily budget defaults to 600 minutes", DEFAULT_VOICE_CONFIG.dailyMinuteBudget === 600);
t.check("a stored config from before the budget still parses", voiceConfigSchema.safeParse({ provider: "deepgram" }).success);
t.check("a negative budget is refused", !voiceConfigSchema.safeParse({ dailyMinuteBudget: -1 }).success);
t.done("voice minutes smoke tests");
