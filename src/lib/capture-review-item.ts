/**
 * The review-time shapes: a parsed person or a suggested reminder, plus whatever the user
 * has decided about it.
 *
 * These lived in `bulk-notes-panel.tsx`, which meant `suggested-reminders-review.tsx`
 * imported a type back out of its own parent. That was survivable while the panel was one
 * file; now that the review UI is split across three, it would be a genuine cycle.
 *
 * Types only, no runtime imports — same constraint as `capture-preview.ts`.
 */

import type {
  BulkNotePersonPreview,
  SuggestedReminderPreview,
} from "@/lib/capture-preview";

/**
 * `pending` exists for a person whose details have not arrived yet — a skeleton row from
 * the roster event. Everything the user has actually seen is `accepted` or `discarded`, and
 * rows arrive `accepted`: the extraction is usually right, and making the common case a
 * scan-and-uncheck rather than N explicit clicks is the point of the list.
 */
export type Decision = "pending" | "accepted" | "discarded";

export type SuggestionReviewItem = SuggestedReminderPreview & {
  checked: boolean;
  /**
   * Overrides which person this date belongs to, by name. Names rather than ids
   * because the contacts do not exist yet at review time — the server resolves the
   * name to a contact id after the person loop creates them.
   */
  personNameOverride: string | null;
};

export type ReviewItem = BulkNotePersonPreview & {
  decision: Decision;
  mergeContactId: string | null;
  createReminder: boolean;
  relationshipScore: number;
  tagNames: string;
  followUpDays: number;
  /** Locked to `lockedParticipantId` — the panel was opened from that contact's profile. */
  locked?: boolean;
  /**
   * A roster row whose detail pass has not landed. It shows the name the identify pass
   * found and a skeleton for everything else, and it cannot be expanded or saved until the
   * `person` event replaces it.
   */
  placeholder?: boolean;
};
