"use client";

import { useEffect, useState } from "react";
import { getMyAiUsage } from "@/actions/usage";
import { formatCostMicros } from "@/lib/ai-pricing";
import type { UsageSummary } from "@/lib/usage-summary-types";

/** How many features the "where it went" line names before folding the rest away. */
const TOP_FEATURES = 3;

/**
 * The last 30 days of AI calls made with this user's own key. The tile shows the count; the
 * detail inside Advanced says where they went and roughly what they cost.
 *
 * Cost is a single approximate figure. `costIsEstimated` (from `UsageSummary`, itself reading
 * `usage_events.cost_source`) decides the wording: Orbit's own `ai-pricing.ts` list-price
 * table runs roughly 5x low, so a figure built from it is always named as an estimate, with
 * the provider's own dashboard as the real number.
 */
export function useAiUsage(): UsageSummary | null | undefined {
  const [summary, setSummary] = useState<UsageSummary | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getMyAiUsage()
      .then((next) => live && setSummary(next))
      .catch(() => live && setSummary(null));
    return () => {
      live = false;
    };
  }, []);
  return summary;
}

export function AiUsageDetails({ summary }: { summary: UsageSummary | null | undefined }) {
  if (summary === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (summary === null) return <p className="text-sm text-muted-foreground">Usage isn’t available right now</p>;

  const totalFailures = summary.rows.reduce((n, r) => n + r.failures, 0);
  // `summary.rows` is ordered by cost, but this line names call VOLUME, so it re-sorts by
  // calls — otherwise an unpriced window would name an arbitrary feature first.
  const byCalls = [...summary.rows].sort((a, b) => b.calls - a.calls);
  const topRows = byCalls.slice(0, TOP_FEATURES);
  const more = byCalls.length - topRows.length;

  return (
    <ul className="space-y-1 text-sm text-muted-foreground tabular-nums">
      {summary.rows.length === 0 ? (
        <li>No calls on your key in the last 30 days</li>
      ) : (
        <>
          <li>
            Most on {topRows.map((row) => `${row.label} (${row.calls.toLocaleString()})`).join(", ")}
            {more > 0 ? ` · ${more} more` : ""}
          </li>
          <li>
            {summary.costIsEstimated
              ? `About ${formatCostMicros(summary.totalCostMicros)} at list prices · your provider has the real number`
              : `${formatCostMicros(summary.totalCostMicros)}, as your provider reports it`}
            {summary.unpricedCalls > 0 ? ` · ${summary.unpricedCalls.toLocaleString()} unpriced` : ""}
          </li>
          {totalFailures > 0 ? (
            <li>
              {totalFailures.toLocaleString()} {totalFailures === 1 ? "call" : "calls"} didn’t complete
            </li>
          ) : null}
        </>
      )}
      {summary.webSearches ? (
        <li>
          {summary.webSearches.used.toLocaleString()} of {summary.webSearches.limit.toLocaleString()} web searches this month
        </li>
      ) : null}
    </ul>
  );
}
