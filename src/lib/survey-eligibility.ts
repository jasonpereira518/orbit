import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { activatedSql } from "@/lib/activity";
import { SURVEY_COOLDOWN_DAYS, type SurveyId } from "@/lib/surveys";

/**
 * Which survey, if any, to put in front of this person right now.
 *
 * ONE PROMPT AT A TIME, AND RARELY. The floating prompt is the least welcome thing in the
 * product, so the rules err hard towards silence: nothing within the cooldown of the last
 * one shown, nothing a person has already answered or dismissed, internal accounts never,
 * and each survey waits for its own moment rather than for a schedule.
 *
 * Read from `product_events` (`survey_shown`, `survey_answered`, `survey_dismissed`) rather
 * than a table of its own: the history of what was asked is exactly the event stream.
 *
 * The cancellation survey is not here. It is asked inside the cancel flow, where the person
 * is already deciding, not floated over the app.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** In the order they win when more than one is due: the most recent action first. */
export const FLOATING_SURVEYS: readonly SurveyId[] = [
  "followup_useful",
  "post_first_capture",
  "day7_not_activated",
  "pmf",
];

export type SurveyFacts = {
  ageMs: number;
  internal: boolean;
  /** When the last floating survey was shown, if ever. */
  lastShownAt: Date | null;
  /** Surveys already answered or dismissed, whenever. */
  settled: ReadonlySet<string>;
  activated: boolean;
  firstSavedCaptureAt: Date | null;
  savedCaptures: number;
  firstCompletionAt: Date | null;
  completions: number;
};

/** Pure: the decision, so every rule is pinned by `scripts/smoke-surveys.ts`. */
export function chooseSurvey(f: SurveyFacts, now: Date): SurveyId | null {
  if (f.internal) return null;
  if (f.lastShownAt && now.getTime() - f.lastShownAt.getTime() < SURVEY_COOLDOWN_DAYS * DAY_MS) return null;

  const due = (id: SurveyId): boolean => {
    switch (id) {
      case "followup_useful":
        // Only the first completion, within a few hours of it.
        return f.completions === 1 && f.firstCompletionAt !== null && now.getTime() - f.firstCompletionAt.getTime() < 3 * HOUR_MS;
      case "post_first_capture":
        // Only the first saved capture, once the review card has had a moment to close.
        return (
          f.savedCaptures === 1 &&
          f.firstSavedCaptureAt !== null &&
          now.getTime() - f.firstSavedCaptureAt.getTime() > 2 * 60_000 &&
          now.getTime() - f.firstSavedCaptureAt.getTime() < 2 * DAY_MS
        );
      case "day7_not_activated":
        return !f.activated && f.ageMs >= 6 * DAY_MS && f.ageMs < 10 * DAY_MS;
      case "pmf":
        return f.activated && f.ageMs >= 21 * DAY_MS && f.ageMs < 35 * DAY_MS;
      default:
        return false;
    }
  };

  for (const id of FLOATING_SURVEYS) {
    if (f.settled.has(id)) continue;
    if (due(id)) return id;
  }
  return null;
}

export async function loadSurveyFacts(userId: string, now: Date): Promise<SurveyFacts | null> {
  const db = await getDb();
  const res = await db.execute(sql`
    SELECT
      s.created_at,
      s.account_kind,
      ${activatedSql(sql`s.user_id`, sql`s.created_at`)} AS activated,
      (SELECT min(created_at) FROM capture_jobs WHERE user_id = s.user_id AND status = 'saved') AS first_capture_at,
      (SELECT count(*)::int FROM capture_jobs WHERE user_id = s.user_id AND status = 'saved') AS captures,
      (SELECT min(completed_at) FROM reminders WHERE user_id = s.user_id AND completed_at IS NOT NULL) AS first_completion_at,
      (SELECT count(*)::int FROM reminders WHERE user_id = s.user_id AND completed_at IS NOT NULL) AS completions,
      (SELECT max(occurred_at) FROM product_events WHERE user_id = s.user_id AND name = 'survey_shown') AS last_shown_at
    FROM user_settings s
    WHERE s.user_id = ${userId}
  `);
  const row = rowsOf<Record<string, string | number | boolean | null>>(res)[0];
  if (!row) return null;
  const settledRes = await db.execute(sql`
    SELECT DISTINCT properties ->> 'survey_id' AS survey_id
    FROM product_events
    WHERE user_id = ${userId} AND name IN ('survey_answered', 'survey_dismissed')
  `);
  const date = (v: unknown) => (v ? new Date(String(v)) : null);
  return {
    ageMs: now.getTime() - new Date(String(row.created_at)).getTime(),
    internal: row.account_kind === "internal",
    lastShownAt: date(row.last_shown_at),
    settled: new Set(rowsOf<{ survey_id: string | null }>(settledRes).flatMap((r) => (r.survey_id ? [r.survey_id] : []))),
    activated: Boolean(row.activated),
    firstSavedCaptureAt: date(row.first_capture_at),
    savedCaptures: Number(row.captures ?? 0),
    firstCompletionAt: date(row.first_completion_at),
    completions: Number(row.completions ?? 0),
  };
}

export async function pickSurveyFor(userId: string, now: Date = new Date()): Promise<SurveyId | null> {
  const facts = await loadSurveyFacts(userId, now);
  return facts ? chooseSurvey(facts, now) : null;
}
