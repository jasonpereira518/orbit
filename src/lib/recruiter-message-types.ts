import { RECRUITER_INTENTS, type RecruiterIntent } from "@/lib/recruiter-drafts";

/**
 * Shared values and types for recruiter outreach.
 *
 * These live outside `src/actions/recruiter-messages.ts` because a `"use server"` module
 * may only export async functions — a single exported constant there makes Next drop
 * every export in the file, so the actions stop resolving entirely. Same split as
 * `outreach-types.ts` next to `outreach-send.ts`.
 */

/**
 * The most recruiter drafts one batch may generate (and so send). Sending itself is bounded
 * by the shared daily email cap (`EMAIL_SEND_DAILY_CAP`); this keeps a single batch of
 * similar AI-written mail small, since a burst of those from one address is what gets an
 * address flagged.
 */
export const RECRUITER_BATCH_LIMIT = 25;

export const RECRUITER_INTENT_OPTIONS = Object.entries(RECRUITER_INTENTS).map(
  ([value, meta]) => ({ value: value as RecruiterIntent, label: meta.label })
);

export type RecruiterDraft = {
  id: string;
  recruiterId: string;
  recruiterName: string;
  recruiterFirm: string | null;
  recruiterEmail: string | null;
  intent: RecruiterIntent;
  subject: string;
  body: string;
  status: string;
  errorMessage: string | null;
};

export type SendDraftsResult = {
  sent: number;
  failed: Array<{ id: string; recruiterName: string; error: string }>;
  quotaRemaining: number;
};
