import type {
  CampaignMetrics,
  OutreachMessageOutcome,
  PipelineFilter,
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
  messages: MessageMetricRow[];
};

const DELIVERED_STATUSES = new Set(["sent", "opened"]);
const REPLY_OUTCOMES = new Set<OutreachMessageOutcome>([
  "positive_reply",
  "negative_reply",
  "neutral_reply",
]);

export function isDeliveredMessage(message: MessageMetricRow) {
  return (
    DELIVERED_STATUSES.has(message.status) ||
    Boolean(message.outcome) ||
    Boolean(message.sentAt)
  );
}

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
  prospects: ProspectMetricRow[],
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
  const successfulReplyRate =
    eligible > 0 ? positiveReplyCount / eligible : null;

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
    successfulReplyRate,
  };
}

export function computeChannelBreakdown(prospects: ProspectMetricRow[]) {
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
      successfulReplyRate: eligible > 0 ? stats.positive / eligible : null,
    };
  });
}

export function computeStepBreakdown(prospects: ProspectMetricRow[]) {
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
        successfulReplyRate: eligible > 0 ? stats.positive / eligible : null,
      };
    });
}

export function prospectPipelineBucket(
  prospect: ProspectMetricRow,
  now: Date = new Date()
): PipelineFilter {
  if (
    prospect.status === "excluded" ||
    prospect.status === "not_interested" ||
    prospect.status === "interested"
  ) {
    return prospect.status === "interested" ? "replied" : "closed";
  }

  const messages = prospect.messages;
  if (!messages.length) return "needs_draft";

  const hasPositive = messages.some((m) => m.outcome === "positive_reply");
  const hasClosedOutcome = messages.some(
    (m) =>
      m.outcome === "negative_reply" ||
      m.outcome === "unsubscribed" ||
      m.outcome === "bounced"
  );
  const hasAnyReply = messages.some(hasReplyOutcome);

  if (hasPositive || prospect.status === "replied") return "replied";
  if (hasClosedOutcome) return "closed";
  if (hasAnyReply) return "replied";

  const dueFollowUp = messages.some(
    (m) =>
      (m.status === "scheduled" &&
        m.scheduledFor &&
        new Date(m.scheduledFor) <= now) ||
      (m.status === "generated" &&
        (m.stepIndex ?? 0) > 0 &&
        !isDeliveredMessage(m))
  );
  if (dueFollowUp) return "follow_up_due";

  const awaiting = messages.some(isAwaitingReply);
  if (awaiting || prospect.status === "contacted") return "awaiting_reply";

  const delivered = messages.some(isDeliveredMessage);
  if (delivered) return "sent";

  const hasUsableDraft = messages.some(
    (m) =>
      Boolean(m.id) &&
      (m.status === "draft" ||
        m.status === "generated" ||
        m.status === "copied" ||
        m.status === "scheduled")
  );
  if (hasUsableDraft) return "ready";

  return "needs_draft";
}
