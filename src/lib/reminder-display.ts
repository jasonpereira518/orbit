/**
 * How a reminder's provenance is labelled and tinted — one table for the reminders page,
 * the dashboard card (via `reminder-card.tsx`) and the onboarding preview, which used to
 * keep its own copy.
 *
 * Keyed by `reminder_type`, the column that records DATE provenance. `origin`
 * (explicit / implied) is a separate fact and is shown separately.
 */

export const REMINDER_TYPE_LABELS: Record<string, string> = {
  manual: "Task",
  capture: "From capture",
  post_meeting: "Post-meeting",
  generated: "Auto-generated",
  ai_suggested: "AI suggested",
  extracted_date: "From notes",
};

export const REMINDER_TYPE_STYLES: Record<string, string> = {
  manual: "bg-muted text-muted-foreground",
  capture: "bg-violet-500/15 text-violet-800 dark:text-violet-200",
  post_meeting: "bg-sky-500/15 text-sky-800 dark:text-sky-200",
  generated: "bg-muted text-muted-foreground",
  ai_suggested: "bg-violet-500/15 text-violet-800 dark:text-violet-200",
  extracted_date: "bg-amber-500/15 text-amber-800 dark:text-amber-200",
};

/** A confirmed note paste relabels any type as "From notes" — it links back to that paste. */
export function reminderTypeLabel(reminderType: string, noteBatchId?: string | null) {
  if (noteBatchId) return "From notes";
  return REMINDER_TYPE_LABELS[reminderType] ?? "Task";
}

export function reminderTypeStyle(reminderType: string) {
  return REMINDER_TYPE_STYLES[reminderType] ?? REMINDER_TYPE_STYLES.manual;
}

/** Whether the chip is worth showing on a dense row: a plain task you typed is the default. */
export function isNoteworthyType(reminderType: string, noteBatchId?: string | null) {
  return Boolean(noteBatchId) || (reminderType !== "manual" && reminderType in REMINDER_TYPE_LABELS);
}
