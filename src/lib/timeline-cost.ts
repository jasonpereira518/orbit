import { estimateCostMicros, formatCostMicros } from "@/lib/ai-pricing";

/**
 * What deriving LinkedIn timeline events costs, and the rules that bound it (audit A6).
 * DB-free: the runner and the privacy/terms pages read these, so the number a person is
 * shown is the number the code enforces. `TimelineBackfillStatus`/`timelineEstimateLabel`
 * below no longer have a production reader — the opt-in checkbox they served is gone
 * (schema v108, task 9) — but stay for their own smoke coverage (smoke-timeline-cost.ts).
 * `pendingTimelineAiContactCount` (src/lib/linkedin-timeline-backfill.ts) is in the same
 * position: it counted the calls that estimate multiplied, lost its only production caller
 * when `getTimelineBackfillStatus` went, and now has only smoke coverage.
 */

/** Threads with fewer usable messages get only the rule-based reach-out, never a model call. */
export const TIMELINE_MIN_MESSAGES_FOR_AI = 2;

/** Model-bound conversations processed per user per UTC day. */
export const TIMELINE_DAILY_CONTACT_CAP = 300;

/**
 * Per-conversation estimate for the fast tier: the extractor sends at most 14,000 characters
 * of transcript (about 3,500 tokens) plus a short system prompt, and most threads are far
 * shorter; it returns at most eight short events. Deliberately a round, slightly generous
 * figure — it used to be shown before consent, so it should not undersell; nothing shows it
 * any more (schema v108 made the backfill automatic), but `timelineEstimateLabel` below
 * still uses it and is still exercised by smoke-timeline-cost.ts.
 */
export const TIMELINE_EST_INPUT_TOKENS = 2_500;
export const TIMELINE_EST_OUTPUT_TOKENS = 150;

export type TimelineBackfillStatus = {
  enabled: boolean;
  /** Conversations still waiting that would each cost one model call. */
  pendingConversations: number;
  hasKey: boolean;
  /** The fast-tier model the runner will use for this user's provider. */
  model: string;
  label: string;
  dailyCap: number;
};

export function usableTimelineMessageCount(
  contents: readonly (string | null | undefined)[]
): number {
  return contents.filter((c) => (c ?? "").trim().length > 0).length;
}

export function qualifiesForTimelineAi(usable: number): boolean {
  return usable >= TIMELINE_MIN_MESSAGES_FOR_AI;
}

/** Micro-dollars, or null when the model is not in the price table (never a guess). */
export function estimateTimelineCostMicros(conversations: number, model: string): number | null {
  if (conversations <= 0) return 0;
  const perCall = estimateCostMicros({
    model,
    inputTokens: TIMELINE_EST_INPUT_TOKENS,
    outputTokens: TIMELINE_EST_OUTPUT_TOKENS,
  });
  return perCall === null ? null : perCall * conversations;
}

export function timelineEstimateLabel(conversations: number, model: string): string {
  if (conversations <= 0) return "Derive timeline events from your LinkedIn conversations";
  const count = conversations.toLocaleString("en-US");
  const noun = conversations === 1 ? "conversation" : "conversations";
  const micros = estimateTimelineCostMicros(conversations, model);
  if (micros === null) return `Derive timeline events for ${count} ${noun} — cost depends on your model`;
  if (micros < 10_000) return `Derive timeline events for ${count} ${noun} — under a cent on your key`;
  return `Derive timeline events for ${count} ${noun} — about ${formatCostMicros(micros)} on your key`;
}

/** The daily cap's bucket key: a UTC calendar day, so the cap resets at 00:00 UTC. */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}
