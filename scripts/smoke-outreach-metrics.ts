/**
 * Pins the outreach metric rules: what counts as delivered, what counts as a reply, the reply
 * rate, and the pipeline bucket a person lands in.
 *
 *   - Only a `sent` message is delivered. A `copied` LinkedIn note, or a legacy `opened` row,
 *     is not, whatever timestamp or outcome sits on it.
 *   - Any reply counts (`replied` and the three toned ones), over sent minus bounced.
 *   - The SQL twin (`campaignMetricAggregates`) is held to the same rules in
 *     `smoke-bounded-reads.ts`.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-outreach-metrics.ts
 */
import { checker } from "./smoke/check";
import {
  computeCampaignMetrics,
  hasReplyOutcome,
  isDeliveredMessage,
  prospectPipelineBucket,
  type MessageMetricRow,
  type ProspectMetricRow,
} from "../src/lib/outreach-metrics";
import { FOLLOW_UP_AFTER_DAYS, type OutreachChannel } from "../src/lib/outreach-types";

const t = checker();
const DAY = 86_400_000;
const NOW = new Date("2026-10-25T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

let seq = 0;
const msg = (over: Partial<MessageMetricRow> = {}): MessageMetricRow => ({
  id: `m${++seq}`, status: "draft", outcome: null, stepIndex: 0, channel: "email", ...over,
});
const person = (
  messages: MessageMetricRow[],
  over: Partial<ProspectMetricRow> = {}
): ProspectMetricRow => ({
  id: `p${++seq}`, status: "selected", email: "a@b.org", linkedinUrl: "https://www.linkedin.com/in/a", messages, ...over,
});
const bucket = (p: ProspectMetricRow, channel: OutreachChannel = "email") => prospectPipelineBucket(p, channel, NOW);
const sentAgo = (n: number, over: Partial<MessageMetricRow> = {}) =>
  msg({ status: "sent", sentAt: daysAgo(n), ...over });

console.log("delivered and reply rules");
t.check("a sent message is delivered", isDeliveredMessage(msg({ status: "sent" })));
t.check("a copied row is not delivered, even with a sentAt", !isDeliveredMessage(msg({ status: "copied", sentAt: new Date() })));
t.check("a legacy opened row is not delivered", !isDeliveredMessage(msg({ status: "opened" })));
t.check("an outcome on a draft does not make it delivered", !isDeliveredMessage(msg({ status: "draft", outcome: "bounced" })));
t.check("a queued or unsure message is not delivered", !isDeliveredMessage(msg({ status: "queued" })) && !isDeliveredMessage(msg({ status: "unsure" })));
for (const outcome of ["replied", "positive_reply", "negative_reply", "neutral_reply"]) {
  t.check(`${outcome} is a reply`, hasReplyOutcome(msg({ status: "sent", outcome })));
}
for (const outcome of ["bounced", "unsubscribed", null]) {
  t.check(`${outcome ?? "no outcome"} is not a reply`, !hasReplyOutcome(msg({ status: "sent", outcome })));
}

console.log("\nreply rate");
{
  const four = [
    person([sentAgo(1, { outcome: "replied" })]),
    person([sentAgo(1, { outcome: "negative_reply" })]),
    person([sentAgo(1)]),
    person([sentAgo(1)]),
  ];
  const m = computeCampaignMetrics(four, NOW);
  t.check("2 replies of 4 sent, 0 bounced is 0.5", m.replyRate === 0.5, String(m.replyRate));
  t.check("sentCount and replyCount", m.sentCount === 4 && m.replyCount === 2, JSON.stringify(m));

  const bounced = computeCampaignMetrics([...four, person([sentAgo(1, { outcome: "bounced" })])], NOW);
  t.check("a bounce leaves the denominator: 2 of (5 − 1) is 0.5", bounced.replyRate === 0.5 && bounced.bouncedCount === 1, JSON.stringify(bounced));

  const none = computeCampaignMetrics([person([msg()]), person([])], NOW);
  t.check("0 sent is null, not 0", none.replyRate === null, String(none.replyRate));
  t.check("every sent bounced is null, not a divide by zero", computeCampaignMetrics([person([sentAgo(1, { outcome: "bounced" })])], NOW).replyRate === null);

  const copied = computeCampaignMetrics([person([msg({ status: "copied", sentAt: new Date() })])], NOW);
  t.check("a copied row is not a send", copied.sentCount === 0 && copied.replyRate === null, JSON.stringify(copied));

  const positiveOnly = computeCampaignMetrics([person([sentAgo(1, { outcome: "replied" })]), person([sentAgo(1)])], NOW);
  t.check("an untoned reply counts, and is not a positive one", positiveOnly.replyRate === 0.5 && positiveOnly.positiveReplyCount === 0);
  t.check("the old field is gone", !("successfulReplyRate" in positiveOnly));
}

console.log("\npipeline buckets");
t.check("needs_info: no email on an email campaign", bucket(person([], { email: null })) === "needs_info");
t.check("needs_info: a blank email is no email", bucket(person([], { email: "  " })) === "needs_info");
t.check("needs_info: no LinkedIn url on a LinkedIn campaign", bucket(person([], { linkedinUrl: null }), "linkedin") === "needs_info");
t.check("…but an email campaign does not need the LinkedIn url", bucket(person([], { linkedinUrl: null })) === "needs_draft");
t.check("…nor a LinkedIn campaign the email", bucket(person([], { email: null }), "linkedin") === "needs_draft");
t.check("needs_info comes before ready: a draft with nowhere to go", bucket(person([msg()], { email: null })) === "needs_info");
t.check("needs_draft: no messages", bucket(person([])) === "needs_draft");
t.check("needs_draft: only a follow-up, no step 0", bucket(person([msg({ stepIndex: 1 })])) === "needs_draft");
for (const status of ["draft", "generated", "copied"]) {
  t.check(`ready: a ${status} first message`, bucket(person([msg({ status })])) === "ready");
}
t.check("waiting: sent, no outcome, not due", bucket(person([sentAgo(FOLLOW_UP_AFTER_DAYS - 1)])) === "waiting");
t.check("follow_up_due: sent a week ago, no outcome, no follow-up", bucket(person([sentAgo(FOLLOW_UP_AFTER_DAYS)])) === "follow_up_due");
t.check("replied: a reply outcome", bucket(person([sentAgo(30, { outcome: "replied" })])) === "replied");
for (const outcome of ["positive_reply", "negative_reply", "neutral_reply"]) {
  t.check(`replied: ${outcome}`, bucket(person([sentAgo(30, { outcome })])) === "replied");
}
t.check("replied beats follow_up_due", bucket(person([sentAgo(30, { outcome: "replied" })])) === "replied");
t.check("failed: status failed", bucket(person([msg({ status: "failed" })])) === "failed");

console.log("\nR1: queued and unsure");
t.check("a queued message is waiting", bucket(person([msg({ status: "queued" })])) === "waiting");
t.check("an unsure message is failed", bucket(person([msg({ status: "unsure" })])) === "failed");

console.log("\nthe follow-up changes the bucket");
t.check("a follow-up draft makes a due person ready: they have something to send",
  bucket(person([sentAgo(10), msg({ stepIndex: 1, status: "draft" })])) === "ready");
t.check("a generated follow-up is ready too",
  bucket(person([sentAgo(10), msg({ stepIndex: 1, status: "generated" })])) === "ready");
t.check("a sent follow-up is waiting, never due again",
  bucket(person([sentAgo(20), sentAgo(2, { stepIndex: 1 })])) === "waiting");
t.check("…and still waiting a month later: one follow-up per person",
  bucket(person([sentAgo(60), sentAgo(40, { stepIndex: 1 })])) === "waiting");
t.check("a reply on the follow-up is a reply", bucket(person([sentAgo(20), sentAgo(2, { stepIndex: 1, outcome: "replied" })])) === "replied");
t.check("a reply on the first message still counts once a follow-up is sent",
  bucket(person([sentAgo(20, { outcome: "positive_reply" }), sentAgo(2, { stepIndex: 1 })])) === "replied");
t.check("a failed follow-up is failed", bucket(person([sentAgo(20), msg({ stepIndex: 1, status: "failed" })])) === "failed");
t.check("a queued follow-up is waiting", bucket(person([sentAgo(20), msg({ stepIndex: 1, status: "queued" })])) === "waiting");

console.log("\nother outcomes and states");
t.check("a bounce is failed: nothing reached them", bucket(person([sentAgo(3, { outcome: "bounced" })])) === "failed");
t.check("an unsubscribe is replied: they answered, nothing more to send", bucket(person([sentAgo(3, { outcome: "unsubscribed" })])) === "replied");
t.check("a prospect status of contacted or replied does not move the bucket (outcomes no longer rewrite it)",
  bucket(person([sentAgo(1)], { status: "replied" })) === "waiting");
t.check("an excluded person is not bucketed: needs_draft, never a pipeline stage",
  bucket(person([sentAgo(30)], { status: "excluded" })) === "needs_draft");
t.check("sentAt as an ISO string (a serialised row) still works",
  bucket(person([msg({ status: "sent", sentAt: daysAgo(9).toISOString() })])) === "follow_up_due");

t.done("outreach metrics");
