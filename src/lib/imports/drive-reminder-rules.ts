import type { SuggestedReminderPreview } from "@/lib/capture/types";
import type { ReminderActionKind } from "@/db/schema";

/**
 * Which of capture's suggested reminders a Drive import may create.
 *
 * Stricter than capture on purpose. In /capture a person reviews every suggestion before it
 * is saved, and the notes are usually from today. A Drive doc is read unattended and can be
 * years old, so capture's defaults would bury someone in overdue reminders for things long
 * done. The rules:
 *
 *  1. Only a date the notes actually state (`origin: "explicit"`, a date phrase, not vague,
 *     year not guessed). Nothing implied, nothing "soon".
 *  2. Only one still ahead of today.
 *  3. At most three per doc, most confident first.
 *
 * A stated date that has already passed, but only just, and that the parse is very sure
 * of, is not dropped silently: it comes back as a flag for the import's detail sheet,
 * where the person can make it a reminder with one click. Nothing is written for a flag.
 */
export const DRIVE_REMINDERS_PER_DOC = 3;
/** On capture's 0–100 scale (see `EXPLICIT_AUTO_TICK_CONFIDENCE`). */
export const FLAG_MIN_CONFIDENCE = 85;
export const FLAG_LOOKBACK_DAYS = 30;

export type DriveFlag = {
  key: string;
  title: string;
  personName: string | null;
  dueDateIso: string;
  sourceExcerpt: string;
  actionKind: ReminderActionKind;
};

/** YYYY-MM-DD in UTC, which is how `dueDateIso` is written. */
function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function statedOutright(s: SuggestedReminderPreview): boolean {
  return (
    (s.origin ?? "explicit") === "explicit" &&
    Boolean(s.rawDatePhrase?.trim()) &&
    s.dateBasis !== "vague" &&
    !s.yearInferred
  );
}

export function applyDriveReminderRules(
  suggestions: readonly SuggestedReminderPreview[],
  now: Date,
): { keep: string[]; flags: DriveFlag[] } {
  const today = dayOf(now);
  const lookback = dayOf(new Date(now.getTime() - FLAG_LOOKBACK_DAYS * 86_400_000));

  const stated = suggestions.filter(statedOutright);

  const keep = stated
    .filter((s) => s.dueDateIso >= today)
    .sort((a, b) => b.confidenceScore - a.confidenceScore)
    .slice(0, DRIVE_REMINDERS_PER_DOC)
    .map((s) => s.key);

  const flags: DriveFlag[] = stated
    .filter(
      (s) =>
        s.dueDateIso < today &&
        s.dueDateIso >= lookback &&
        s.dateBasis === "absolute" &&
        s.confidenceScore >= FLAG_MIN_CONFIDENCE,
    )
    .map((s) => ({
      key: s.key,
      title: s.title,
      personName: s.personName,
      dueDateIso: s.dueDateIso,
      sourceExcerpt: s.sourceExcerpt,
      actionKind: s.actionKind,
    }));

  return { keep, flags };
}

/**
 * Whether a person's generic follow-up (due `anchor + days`) would still be ahead of today.
 * For an old doc it usually is not, and an overdue follow-up is noise, not a nudge.
 */
export function followUpStillAhead(anchorIso: string, days: number, now: Date): boolean {
  const due = new Date(`${anchorIso}T12:00:00Z`).getTime() + days * 86_400_000;
  return dayOf(new Date(due)) >= dayOf(now);
}
