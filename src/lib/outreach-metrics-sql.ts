import { sql, type SQL } from "drizzle-orm";
import { outreachMessages, outreachProspects } from "@/db/schema";
import type { CampaignMetrics } from "@/lib/outreach-types";

/**
 * `computeCampaignMetrics` (`outreach-metrics.ts`) as SQL aggregates, for surfaces that only
 * COUNT a campaign's prospects and messages: the outreach list and the dashboard card.
 *
 * Those two used to load every campaign with every prospect and every message under it —
 * a row per message, over one HTTPS round trip that grew with the account — only to count
 * them in JavaScript. These fields go in one `GROUP BY` over
 * `outreach_campaigns LEFT JOIN outreach_prospects LEFT JOIN outreach_messages`, so a
 * campaign comes back as one row of numbers.
 *
 * Each FILTER mirrors a predicate in `outreach-metrics.ts` exactly, JavaScript truthiness
 * included — keep the two in step (`scripts/smoke-bounded-reads.ts` compares them on a
 * fixture built to hit every edge):
 *
 *   - `isDeliveredMessage`: status is sent/opened, OR `Boolean(outcome)` (so NULL and '' are
 *     both "no outcome"), OR `Boolean(sentAt)` (any non-null timestamp).
 *   - `hasReplyOutcome`: outcome is one of the three reply outcomes.
 *   - `isAwaitingReply`: delivered AND `!outcome`.
 *   - pending follow-ups: a `scheduled` message whose `scheduled_for <= now`, plus a
 *     `generated` message past step 0 that is not delivered. The two statuses differ, so one
 *     FILTER with OR counts them exactly as the two separate `+= 1`s did. `scheduled_for` is
 *     truncated to the millisecond first, as parsing it into a JavaScript Date does, so the
 *     comparison with `now` (a Date) agrees at the boundary too.
 *
 * Messages are counted with `count(m.id)`, so the NULL row a LEFT JOIN makes for a prospect
 * with no messages (or a campaign with no prospects) is never counted, whatever a FILTER says
 * about it. Prospects are counted DISTINCT because the message join repeats each one.
 *
 * Deliberately not in `outreach-metrics.ts`: client components import that file for
 * `formatReplyRate`, and this one pulls in the schema.
 */
export function campaignMetricAggregates(now: Date) {
  const m = outreachMessages;
  const p = outreachProspects;
  const delivered = sql`(
    ${m.status} in ('sent', 'opened')
    or coalesce(${m.outcome}, '') <> ''
    or ${m.sentAt} is not null
  )`;
  const countMessages = (where: SQL) =>
    sql<number>`count(${m.id}) filter (where ${where})`.mapWith(Number);
  return {
    prospectCount: sql<number>`count(distinct ${p.id})`.mapWith(Number),
    selectedCount: sql<number>`count(distinct ${p.id}) filter (where ${p.status} = 'selected')`.mapWith(Number),
    sentCount: countMessages(delivered),
    bouncedCount: countMessages(sql`${m.outcome} = 'bounced'`),
    replyCount: countMessages(sql`${m.outcome} in ('positive_reply', 'negative_reply', 'neutral_reply')`),
    positiveReplyCount: countMessages(sql`${m.outcome} = 'positive_reply'`),
    negativeReplyCount: countMessages(sql`${m.outcome} = 'negative_reply'`),
    awaitingReplyCount: countMessages(sql`${delivered} and coalesce(${m.outcome}, '') = ''`),
    pendingFollowUpCount: countMessages(sql`(
      (
        ${m.status} = 'scheduled'
        and ${m.scheduledFor} is not null
        and date_trunc('milliseconds', ${m.scheduledFor}) <= ${now.toISOString()}::timestamptz
      )
      or (
        ${m.status} = 'generated'
        and coalesce(${m.stepIndex}, 0) > 0
        and not ${delivered}
      )
    )`),
  };
}

type MetricCounts = Omit<CampaignMetrics, "successfulReplyRate">;

/** The aggregate row as `CampaignMetrics`, with the rate derived exactly as `computeCampaignMetrics` does. */
export function metricsFromAggregates(row: MetricCounts): CampaignMetrics {
  const eligible = Math.max(0, row.sentCount - row.bouncedCount);
  return {
    prospectCount: row.prospectCount,
    selectedCount: row.selectedCount,
    sentCount: row.sentCount,
    bouncedCount: row.bouncedCount,
    replyCount: row.replyCount,
    positiveReplyCount: row.positiveReplyCount,
    negativeReplyCount: row.negativeReplyCount,
    awaitingReplyCount: row.awaitingReplyCount,
    pendingFollowUpCount: row.pendingFollowUpCount,
    successfulReplyRate: eligible > 0 ? row.positiveReplyCount / eligible : null,
  };
}
