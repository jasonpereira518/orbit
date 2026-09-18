/**
 * Slack DM the moment a feedback row needing review lands, rather than waiting on the
 * ops-sweep cadence — feedback volume is low enough that there's no dedup/backoff to design
 * for, and "one new item" doesn't fit the sweep's open/remind/recover state machine anyway.
 */

import { getAppBaseUrl } from "@/lib/app-url";
import { sendSlackDM } from "@/lib/slack-dm";

const SNIPPET_LENGTH = 200;

/**
 * `category`/`area`/`text` are plain nullable `text()` columns (see `schema.ts`) — the
 * closed lists in `feedback-report.ts` are enforced only at the Zod validation boundary, not
 * in the DB type, so this accepts the same loose shape a raw row read gives back.
 */
export type SubmittedFeedback = {
  id: string;
  category: string | null;
  area: string | null;
  text: string | null;
};

/**
 * Fire-and-forget. Swallows every error, matching `recordFeedback`'s "never fail the user's
 * action" contract in `feedback.ts` — a Slack outage must never turn a successful feedback
 * submission into a visible failure.
 */
export async function notifyFeedbackSubmitted(entry: SubmittedFeedback): Promise<void> {
  const tags = [entry.category, entry.area].filter(Boolean).join(" / ");
  const body = entry.text?.trim() || "(no message)";
  const snippet = body.length > SNIPPET_LENGTH ? `${body.slice(0, SNIPPET_LENGTH)}…` : body;
  const link = `${getAppBaseUrl()}/admin/feedback/${entry.id}`;
  const text = `:speech_balloon: *New feedback*${tags ? ` (${tags})` : ""}\n${snippet}\n${link}`;
  await sendSlackDM(text).catch(() => {});
}
