/**
 * Slack DM the moment a feedback report lands, rather than waiting on the ops-sweep cadence —
 * feedback volume is low enough that there's no dedup/backoff to design for, and "one new
 * item" doesn't fit the sweep's open/remind/recover state machine anyway.
 *
 * Written to be understood from the notification alone: what kind of thing it is and how much
 * it matters (from the triage pass), who sent it and how long they've been around, where they
 * were, and what they actually said. The admin link is for acting on it, not for finding out
 * what it is. What this sends to Slack is described on /privacy — change both together.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";
import type { FeedbackTriage } from "@/lib/feedback-report";
import { PLAN_LABELS, type Plan } from "@/lib/plans/plan-config";
import { sendSlackDM } from "@/lib/slack-dm";

/** Enough to read the whole of nearly every report without opening the console. */
export const DM_TEXT_MAX = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `category`/`area`/`text` are plain nullable `text()` columns (see `schema.ts`) — the
 * closed lists in `feedback-report.ts` are enforced only at the Zod validation boundary, not
 * in the DB type, so this accepts the same loose shape a raw row read gives back.
 */
export type SubmittedFeedback = {
  id: string;
  userId: string;
  plan: Plan | null;
  area: string | null;
  /** What the triage pass decided, or what the row already had. */
  category: string | null;
  /** The subject line they gave it. */
  subject?: string | null;
  text: string | null;
  path: string | null;
  screenshotCount: number;
  triage: FeedbackTriage | null;
};

export type Submitter = { email: string | null; joinedAt: Date | null };

/**
 * Slack reads `&`, `<` and `>` as markup — `<!channel>` pings, `<url|label>` hides a link
 * behind any text. The report is user-written, so it goes in literally.
 */
function slackEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function memberFor(joinedAt: Date | null, now: Date): string | null {
  if (!joinedAt) return null;
  const days = Math.max(0, Math.floor((now.getTime() - joinedAt.getTime()) / DAY_MS));
  if (days === 0) return "joined today";
  return `member ${days} day${days === 1 ? "" : "s"}`;
}

/** The DM's text. Pure, so the smoke can pin the format without Slack or a database. */
export function buildFeedbackDm(
  entry: SubmittedFeedback,
  submitter: Submitter,
  baseUrl: string,
  now = new Date()
): string {
  const headline = [entry.category, entry.triage?.severity].filter(Boolean).join(" · ");
  const summary = entry.triage?.summary ? ` — ${slackEscape(entry.triage.summary)}` : "";
  const who = [
    `From ${submitter.email ? slackEscape(submitter.email) : "an unknown account"}`,
    entry.plan ? PLAN_LABELS[entry.plan] : null,
    memberFor(submitter.joinedAt, now),
    entry.path ? `on ${slackEscape(entry.path)}` : entry.area ? `in ${entry.area}` : null,
    entry.screenshotCount > 0
      ? `${entry.screenshotCount} screenshot${entry.screenshotCount === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const body = entry.text?.trim() || "(no message)";
  const clipped = body.length > DM_TEXT_MAX ? `${body.slice(0, DM_TEXT_MAX)}…` : body;
  const quoted = slackEscape(clipped)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return [
    `:speech_balloon: *${headline || "New feedback"}*${summary}`,
    who,
    entry.subject ? `*${slackEscape(entry.subject)}*` : null,
    quoted,
    entry.triage?.duplicateOf
      ? `Looks like an earlier report: ${baseUrl}/admin/feedback/${entry.triage.duplicateOf}`
      : null,
    `${baseUrl}/admin/feedback/${entry.id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function loadSubmitter(userId: string): Promise<Submitter> {
  try {
    const db = await getDb();
    const [row] = await db
      .select({ email: userSettings.email, joinedAt: userSettings.createdAt })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    return row ?? { email: null, joinedAt: null };
  } catch {
    // The DM is worth more without the sender than not at all.
    return { email: null, joinedAt: null };
  }
}

/**
 * Fire-and-forget. Swallows every error, matching `recordFeedback`'s "never fail the user's
 * action" contract in `feedback.ts` — a Slack outage must never turn a successful feedback
 * submission into a visible failure.
 */
export async function notifyFeedbackSubmitted(entry: SubmittedFeedback): Promise<void> {
  const submitter = await loadSubmitter(entry.userId);
  await sendSlackDM(buildFeedbackDm(entry, submitter, getAppBaseUrl())).catch(() => {});
}

/** The DM for a reporter's reply in a feedback conversation. Pure, like `buildFeedbackDm`. */
export function buildFeedbackReplyDm(
  input: { feedbackId: string; body: string },
  submitter: Submitter,
  baseUrl: string
): string {
  const body = input.body.trim();
  const clipped = body.length > DM_TEXT_MAX ? `${body.slice(0, DM_TEXT_MAX)}…` : body;
  return [
    `:left_speech_bubble: *Reply on feedback* from ${submitter.email ? slackEscape(submitter.email) : "an unknown account"}`,
    slackEscape(clipped)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
    `${baseUrl}/admin/feedback/${input.feedbackId}`,
  ].join("\n");
}

/** Fire-and-forget, like `notifyFeedbackSubmitted`. */
export async function notifyFeedbackReply(input: {
  feedbackId: string;
  userId: string;
  body: string;
}): Promise<void> {
  const submitter = await loadSubmitter(input.userId);
  await sendSlackDM(buildFeedbackReplyDm(input, submitter, getAppBaseUrl())).catch(() => {});
}
