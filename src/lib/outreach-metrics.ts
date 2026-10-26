import { followUpDue } from "@/lib/outreach-followups";
import {
  CONTACTED_STATUSES,
  EMAILED_STATUSES,
  LINKEDIN_CONTACTED_STATUSES,
  type CampaignMetrics,
  type OutreachChannel,
  type OutreachMessageOutcome,
  type PipelineFilter,
} from "@/lib/outreach-types";

export type MessageMetricRow = {
  id: string;
  status: string;
  outcome: string | null;
  stepIndex?: number | null;
  channel?: string | null;
  sentAt?: Date | string | null;
  scheduledFor?: Date | string | null;
  repliedAt?: Date | string | null;
};

export type ProspectMetricRow = {
  id: string;
  status: string;
  email: string | null;
  linkedinUrl: string | null;
  messages: MessageMetricRow[];
};

/** What the counts need of a person; the pipeline bucket also needs where they can be reached. */
type CountedProspect = Pick<ProspectMetricRow, "status" | "messages">;

const REPLY_OUTCOMES = new Set<OutreachMessageOutcome>([
  "replied",
  "positive_reply",
  "negative_reply",
  "neutral_reply",
]);

/**
 * Only a message the provider accepted counts as sent. A `copied` LinkedIn note, a legacy
 * `opened` row, a `queued` or `unsure` send, and a draft that somehow carries a timestamp or
 * an outcome are all not delivered. The SQL twin is `campaignMetricAggregates`.
 */
export function isDeliveredMessage(message: MessageMetricRow) {
  return message.status === "sent";
}

/** Orbit (or the person) has already reached out to them, on any channel. */
export function hasBeenContacted(messages: { status: string }[]) {
  return messages.some((m) => CONTACTED_STATUSES.includes(m.status));
}

/** An email to them is queued, sent or may have been: the address now stays as it is. */
export function hasBeenEmailed(messages: { status: string; channel?: string | null }[]) {
  return messages.some((m) => m.channel === "email" && EMAILED_STATUSES.includes(m.status));
}

/** A LinkedIn note to them is copied or sent: the profile link now stays as it is. */
export function hasBeenContactedOnLinkedin(messages: { status: string; channel?: string | null }[]) {
  return messages.some((m) => m.channel === "linkedin" && LINKEDIN_CONTACTED_STATUSES.includes(m.status));
}

/**
 * Someone the user already knows. Either the address came from their contact, or the campaign
 * linked them to one when they were added. A contact exists after a send too (made when the
 * message goes out), so `contactId` alone only counts before anything was sent.
 */
export function isInNetwork(person: {
  contactId: string | null;
  enrichment: { emailSource?: string | null } | null;
  messages: { status: string }[];
}) {
  if (person.enrichment?.emailSource === "contact") return true;
  return Boolean(person.contactId) && !hasBeenContacted(person.messages);
}

/** Any reply counts, whatever its tone. A bounce and an unsubscribe are not replies. */
export function hasReplyOutcome(message: MessageMetricRow) {
  return Boolean(message.outcome && REPLY_OUTCOMES.has(message.outcome as OutreachMessageOutcome));
}

export function isAwaitingReply(message: MessageMetricRow) {
  return isDeliveredMessage(message) && !message.outcome;
}

export function formatReplyRate(rate: number | null) {
  if (rate == null) return "—";
  return `${Math.round(rate * 1000) / 10}%`;
}

export function computeCampaignMetrics(
  prospects: CountedProspect[],
  now: Date = new Date()
): CampaignMetrics {
  const selectedCount = prospects.filter((p) => p.status === "selected").length;
  let sentCount = 0;
  let bouncedCount = 0;
  let replyCount = 0;
  let positiveReplyCount = 0;
  let negativeReplyCount = 0;
  let awaitingReplyCount = 0;
  let pendingFollowUpCount = 0;

  for (const prospect of prospects) {
    for (const message of prospect.messages) {
      if (isDeliveredMessage(message)) {
        sentCount += 1;
      }
      if (message.outcome === "bounced") {
        bouncedCount += 1;
      }
      if (hasReplyOutcome(message)) {
        replyCount += 1;
      }
      if (message.outcome === "positive_reply") {
        positiveReplyCount += 1;
      }
      if (message.outcome === "negative_reply") {
        negativeReplyCount += 1;
      }
      if (isAwaitingReply(message)) {
        awaitingReplyCount += 1;
      }
      if (
        message.status === "scheduled" &&
        message.scheduledFor &&
        new Date(message.scheduledFor) <= now
      ) {
        pendingFollowUpCount += 1;
      }
      if (
        message.status === "generated" &&
        (message.stepIndex ?? 0) > 0 &&
        !isDeliveredMessage(message)
      ) {
        // Generated follow-up ready to send
        pendingFollowUpCount += 1;
      }
    }
  }

  const eligible = Math.max(0, sentCount - bouncedCount);
  const replyRate = eligible > 0 ? replyCount / eligible : null;

  return {
    prospectCount: prospects.length,
    selectedCount,
    sentCount,
    bouncedCount,
    replyCount,
    positiveReplyCount,
    negativeReplyCount,
    awaitingReplyCount,
    pendingFollowUpCount,
    replyRate,
  };
}

export function computeChannelBreakdown(prospects: CountedProspect[]) {
  const byChannel = new Map<
    string,
    { sent: number; bounced: number; positive: number; replies: number }
  >();

  for (const prospect of prospects) {
    for (const message of prospect.messages) {
      const channel = message.channel || "unknown";
      const row = byChannel.get(channel) || {
        sent: 0,
        bounced: 0,
        positive: 0,
        replies: 0,
      };
      if (isDeliveredMessage(message)) row.sent += 1;
      if (message.outcome === "bounced") row.bounced += 1;
      if (message.outcome === "positive_reply") row.positive += 1;
      if (hasReplyOutcome(message)) row.replies += 1;
      byChannel.set(channel, row);
    }
  }

  return Array.from(byChannel.entries()).map(([channel, stats]) => {
    const eligible = Math.max(0, stats.sent - stats.bounced);
    return {
      channel,
      sent: stats.sent,
      positiveReplies: stats.positive,
      replies: stats.replies,
      replyRate: eligible > 0 ? stats.replies / eligible : null,
    };
  });
}

export function computeStepBreakdown(prospects: CountedProspect[]) {
  const byStep = new Map<
    number,
    { sent: number; bounced: number; positive: number; replies: number }
  >();

  for (const prospect of prospects) {
    for (const message of prospect.messages) {
      const step = message.stepIndex ?? 0;
      const row = byStep.get(step) || {
        sent: 0,
        bounced: 0,
        positive: 0,
        replies: 0,
      };
      if (isDeliveredMessage(message)) row.sent += 1;
      if (message.outcome === "bounced") row.bounced += 1;
      if (message.outcome === "positive_reply") row.positive += 1;
      if (hasReplyOutcome(message)) row.replies += 1;
      byStep.set(step, row);
    }
  }

  return Array.from(byStep.entries())
    .sort(([a], [b]) => a - b)
    .map(([stepIndex, stats]) => {
      const eligible = Math.max(0, stats.sent - stats.bounced);
      return {
        stepIndex,
        label: stepIndex === 0 ? "Initial" : `Follow-up ${stepIndex}`,
        sent: stats.sent,
        positiveReplies: stats.positive,
        replies: stats.replies,
        replyRate: eligible > 0 ? stats.replies / eligible : null,
      };
    });
}

/**
 * The stage a person is at, for the campaign's filter chips. Pure, and client-safe.
 *
 * Reads the person's first message (step 0), and their follow-up (the highest step above 0)
 * when there is one. The prospect's own status only matters for `excluded`: a reply, a
 * bounce or an unsubscribe is an outcome on a message and never rewrites it.
 *
 *   needs_info     no address on the campaign's channel (an email, or a LinkedIn url)
 *   needs_draft    no first message (or one that was skipped)
 *   ready          a draft, generated or copied message waits to be sent. A follow-up draft
 *                  makes a due person ready: they have something to send.
 *   waiting        sent (or being sent) and not yet due for a follow-up
 *   follow_up_due  `followUpDue` on the first message
 *   replied        any reply outcome on either message, or an unsubscribe (they answered,
 *                  and there is nothing more to send)
 *   failed         the current message failed, may have failed (`unsure`), or bounced
 *
 * `queued` buckets as `waiting` and `unsure` as `failed`. An `excluded` person is not in the
 * pipeline at all; callers drop them first, and one that gets here is `needs_draft` rather
 * than a stage of its own.
 */
export function prospectPipelineBucket(
  prospect: ProspectMetricRow,
  channel: OutreachChannel,
  now: Date = new Date()
): PipelineFilter {
  if (prospect.status === "excluded") return "needs_draft";
  if (channel === "email" && !prospect.email?.trim()) return "needs_info";
  if (channel === "linkedin" && !prospect.linkedinUrl?.trim()) return "needs_info";

  const stepOf = (m: MessageMetricRow) => m.stepIndex ?? 0;
  const first = prospect.messages.find((m) => stepOf(m) === 0);
  if (!first) return "needs_draft";
  const followUp = prospect.messages
    .filter((m) => stepOf(m) > 0)
    .sort((a, b) => stepOf(b) - stepOf(a))[0];

  if (prospect.messages.some((m) => hasReplyOutcome(m) || m.outcome === "unsubscribed")) return "replied";
  if (prospect.messages.some((m) => m.outcome === "bounced")) return "failed";

  const current = followUp ?? first;
  if (current.status === "failed" || current.status === "unsure") return "failed";
  if (current.status === "queued") return "waiting";
  if (current.status === "sent") {
    const due = followUpDue(
      {
        stepIndex: 0,
        status: first.status,
        sentAt: first.sentAt ? new Date(first.sentAt) : null,
        outcome: first.outcome || null,
      },
      Boolean(followUp),
      now
    );
    return due ? "follow_up_due" : "waiting";
  }
  if (current.status === "skipped") return "needs_draft";
  return "ready";
}
