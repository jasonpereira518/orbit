"use server";

import { requireUserId } from "@/lib/auth";
import { trackNow } from "@/lib/product-events";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { pickSurveyFor } from "@/lib/survey-eligibility";
import { SURVEY_DEFINITIONS, SURVEY_QUESTION_ID, isSurveyId, isValidAnswer, type SurveyDefinition } from "@/lib/surveys";

/**
 * The micro-survey prompt's three calls. Each is cheap, each swallows its own failure: a
 * survey that errors must look like no survey, never like a broken app.
 *
 * Reading is separate from "shown" on purpose. The prompt asks for a survey after the page has
 * been idle, and only records `survey_shown` (which starts the cooldown) once it has actually
 * rendered. A fetch that never became a prompt costs the person nothing.
 */

export type SurveyPrompt = Pick<SurveyDefinition, "id" | "question" | "why" | "options">;

/** Which survey to show, or null. Never writes. */
export async function getSurveyPrompt(): Promise<SurveyPrompt | null> {
  try {
    const userId = await requireUserId();
    const id = await pickSurveyFor(userId);
    if (!id) return null;
    const { question, why, options } = SURVEY_DEFINITIONS[id];
    return { id, question, why, options };
  } catch {
    return null;
  }
}

async function limited(userId: string): Promise<boolean> {
  try {
    await consumeBucket("survey", userId, RATE_LIMITS.survey);
    return false;
  } catch (err) {
    if (isRateLimitedError(err)) return true;
    throw err;
  }
}

/** The prompt rendered. Starts the cooldown. */
export async function markSurveyShown(surveyId: string): Promise<void> {
  try {
    const userId = await requireUserId();
    if (!isSurveyId(surveyId) || (await limited(userId))) return;
    await trackNow("survey_shown", { survey_id: surveyId }, { userId });
  } catch {
    // A lost impression only means the cooldown does not start.
  }
}

/** A closed answer. Anything not on the survey's own list is dropped. */
export async function answerSurvey(surveyId: string, answer: string): Promise<{ ok: boolean }> {
  try {
    const userId = await requireUserId();
    if (!isSurveyId(surveyId) || !isValidAnswer(surveyId, answer)) return { ok: false };
    if (await limited(userId)) return { ok: false };
    await trackNow("survey_answered", { survey_id: surveyId, question_id: SURVEY_QUESTION_ID, answer }, { userId });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** "Not now". Counts as settled: the same question is not asked again. */
export async function dismissSurvey(surveyId: string): Promise<void> {
  try {
    const userId = await requireUserId();
    if (!isSurveyId(surveyId) || (await limited(userId))) return;
    await trackNow("survey_dismissed", { survey_id: surveyId }, { userId });
  } catch {
    // Dismissal is best-effort; the worst case is being asked once more after the cooldown.
  }
}
