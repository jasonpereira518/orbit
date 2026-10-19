import { currentMrrCents, mrrMovement } from "@/lib/billing-events";
import { formatRate } from "@/lib/format-rate";
import {
  channelBreakdown,
  cohortActivation,
  connectorUse,
  costSince,
  failuresTouchingUsers,
  feedbackCounts,
  gateConversion,
  openAlerts,
  weeklyActiveNetworkers,
  week2Return,
  type ChannelRow,
  type CohortCount,
  type ConnectorUse,
  type FailureSummary,
  type FeedbackCounts,
  type GateConversion,
  type Wan,
} from "@/lib/product-metrics";

/**
 * The Monday message: the handful of numbers that decide what to do this week, in one Slack
 * post. It is built to be read in thirty seconds and to never overstate.
 *
 * COUNTS WITH THEIR DENOMINATORS. "9 of 14", with a percentage only once the base reaches
 * thirty (`formatRate`). A week of a dozen sign-ups has no rate worth printing, and the
 * digest says so by printing the fraction.
 *
 * COHORTS THAT HAVE HAD TIME. Activation is reported for the accounts that finished their
 * seven-day window last week, and week-2 return for those that finished fourteen days; this
 * week's sign-ups have not had the chance and are never scored.
 *
 * No account is named. Cost and failure lines say how many accounts and how much; the console
 * says who.
 */

export type WeeklyDigest = {
  weekEnding: string;
  wan: Wan;
  newAccounts: { current: number; previous: number; channels: ChannelRow[] };
  activation: CohortCount;
  week2: CohortCount;
  failures: FailureSummary;
  gates: GateConversion;
  money: { mrrCents: number; cashInCents: number; churnCents: number; refundedCents: number };
  cost: { aiMicros: number; speechMicros: number };
  feedback: FeedbackCounts;
  mcp: ConnectorUse;
  extension: ConnectorUse;
  alerts: { critical: number; warning: number; info: number };
};

export async function loadWeeklyDigest(now: Date = new Date()): Promise<WeeklyDigest> {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const [wan, channels, previousChannels, activation, week2, failures, gates, mrrCents, movement, cost, feedback, mcp, extension, alerts] =
    await Promise.all([
      weeklyActiveNetworkers(now),
      channelBreakdown(now, 7),
      // The week before: the same window, ending a week ago.
      channelBreakdown(weekAgo, 7),
      // The cohort that finished its seven-day window in the past week: created 14 to 7 days ago.
      cohortActivation(now, 14, 7),
      // Accounts that have been around fourteen days: created 28 to 14 days ago.
      week2Return(now, 28, 14),
      failuresTouchingUsers(now, 7),
      gateConversion(now, 7),
      currentMrrCents(now),
      mrrMovement(weekAgo, now),
      costSince(now, 7),
      feedbackCounts(now, 7),
      connectorUse(now, "mcp", 28),
      connectorUse(now, "extension", 28),
      openAlerts(),
    ]);
  return {
    weekEnding: now.toISOString().slice(0, 10),
    wan,
    newAccounts: {
      current: channels.reduce((n, r) => n + r.signups, 0),
      previous: previousChannels.reduce((n, r) => n + r.signups, 0),
      channels,
    },
    activation,
    week2,
    failures,
    gates,
    money: {
      mrrCents,
      cashInCents: movement.cashInCents,
      churnCents: Math.abs(movement.churnCents),
      refundedCents: movement.refundedCents,
    },
    cost,
    feedback,
    mcp,
    extension,
    alerts,
  };
}

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const usdMicros = (micros: number) => usd(micros / 10_000);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const trend = (now: number, before: number) => (now === before ? "same as last week" : `${before.toLocaleString()} last week`);

/** Slack mrkdwn. Pure, so the wording is pinned by `scripts/smoke-weekly-digest.ts`. */
export function formatWeeklyDigest(d: WeeklyDigest): string {
  const lines: string[] = [];
  lines.push(`:bar_chart: *Orbit weekly* · week ending ${d.weekEnding}`);

  lines.push(
    `*Active networkers (7 days):* ${d.wan.current.toLocaleString()} (${trend(d.wan.current, d.wan.previous)}) · ${formatRate(d.wan.current, d.wan.mau)} of this month's active`
  );

  const chan = d.newAccounts.channels
    .slice(0, 4)
    .map((c) => `${c.channel} ${c.signups}`)
    .join(", ");
  lines.push(
    `*New accounts:* ${d.newAccounts.current.toLocaleString()} (${trend(d.newAccounts.current, d.newAccounts.previous)})${chan ? ` · ${chan}` : ""}`
  );

  lines.push(
    d.activation.size === 0
      ? `*Activation:* no accounts finished their first week this week.`
      : `*Activation* (accounts that finished their first week): ${formatRate(d.activation.activated, d.activation.size)}`
  );
  lines.push(
    d.week2.size === 0
      ? `*Back in week two:* nobody has reached two weeks yet.`
      : `*Back in week two:* ${formatRate(d.week2.activated, d.week2.size)}`
  );

  lines.push(
    d.failures.accounts === 0
      ? `*Failures people saw:* none.`
      : `*Failures people saw:* ${plural(d.failures.accounts, "account")} (${d.failures.flows.map((f) => `${f.flow} ${f.accounts}`).join(", ")})`
  );

  lines.push(
    d.gates.accounts === 0
      ? `*Limits hit:* none.`
      : `*Limits hit:* ${plural(d.gates.accounts, "account")} · ${d.gates.converted} paid within a week${d.gates.byFeature[0] ? ` · most: ${d.gates.byFeature[0].feature} (${d.gates.byFeature[0].accounts})` : ""}`
  );

  lines.push(
    `*Money:* MRR ${usd(d.money.mrrCents)} · cash in ${usd(d.money.cashInCents)}${d.money.churnCents ? ` · churned ${usd(d.money.churnCents)}/mo` : ""}${d.money.refundedCents ? ` · refunded ${usd(d.money.refundedCents)}` : ""}`
  );

  const totalCost = d.cost.aiMicros + d.cost.speechMicros;
  const perActive = d.wan.current > 0 ? ` · ${usdMicros(totalCost / d.wan.current)} per active networker` : "";
  lines.push(`*Cost (7 days):* ${usdMicros(d.cost.aiMicros)} AI + ${usdMicros(d.cost.speechMicros)} voice${perActive}`);

  if (d.mcp.connected + d.mcp.calls + d.extension.connected + d.extension.calls > 0) {
    lines.push(
      `*Connectors (28 days):* MCP ${d.mcp.connected} connected, ${d.mcp.withCall} used it, ${d.mcp.returning} back this week · extension ${d.extension.connected} installed, ${d.extension.withCall} used it, ${d.extension.returning} back this week`
    );
  }

  const fb = d.feedback.byCategory.map((c) => `${c.category} ${c.count}`).join(", ");
  lines.push(`*Feedback:* ${fb || "none this week"} · ${d.feedback.unresolved} unresolved`);

  lines.push(
    d.alerts.critical + d.alerts.warning === 0
      ? `*Alerts open:* none${d.alerts.info ? ` (${d.alerts.info} info)` : ""}`
      : `*Alerts open:* ${d.alerts.critical} critical, ${d.alerts.warning} warning`
  );

  return lines.join("\n");
}
