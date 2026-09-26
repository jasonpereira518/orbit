"use client";

import { useEffect, useState } from "react";
import { getMyAiUsage } from "@/actions/usage";
import { formatCostMicros } from "@/lib/ai-pricing";
import type { UsageSummary } from "@/lib/usage-summary-types";
import { SettingsSection } from "@/components/settings/settings-section";

/** How many feature labels the "where it went" sentence names before folding the rest away. */
const TOP_FEATURES = 3;

/**
 * The last 30 days of AI calls made with this user's own key: what Orbit did, in a sentence,
 * then roughly what it cost. Deliberately activity-first — a table of tokens and failure
 * counts told people nothing they could act on.
 *
 * Cost is a single approximate figure. `costIsEstimated` (from `UsageSummary`, itself reading
 * `usage_events.cost_source`) decides the wording: Orbit's own `ai-pricing.ts` list-price
 * table runs roughly 5x low, so a figure built from it is always named as a guess, with the
 * provider's own dashboard pointed to as the real number. Only when every call in the window
 * carries a provider-reported cost is the figure stated plainly.
 */
export function AiUsageCard() {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    getMyAiUsage()
      .then((next) => {
        if (live) setSummary(next);
      })
      .catch(() => {
        if (live) setUnavailable(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const totalFailures = summary?.rows.reduce((n, r) => n + r.failures, 0) ?? 0;
  const cost = summary ? formatCostMicros(summary.totalCostMicros) : null;
  const topRows = summary?.rows.slice(0, TOP_FEATURES) ?? [];
  const hasMoreRows = (summary?.rows.length ?? 0) > TOP_FEATURES;

  return (
    <SettingsSection
      title="AI usage"
      description="Calls made with your own key over the last 30 days."
    >
      {unavailable ? (
        <p className="text-sm text-muted-foreground">Usage isn’t available right now.</p>
      ) : !summary ? (
        <p className="text-sm text-muted-foreground">Loading usage…</p>
      ) : summary.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No AI calls in the last 30 days.</p>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="text-ink">
            {summary.totalCalls.toLocaleString()} AI {summary.totalCalls === 1 ? "call" : "calls"} in
            the last 30 days.
          </p>
          <p className="text-muted-foreground">
            Most of it was{" "}
            {topRows.map((row, i) => (
              <span key={row.operation}>
                {i > 0 ? (i === topRows.length - 1 && !hasMoreRows ? " and " : ", ") : ""}
                {row.label} ({row.calls.toLocaleString()})
              </span>
            ))}
            {hasMoreRows ? ", and a few other things" : ""}.
          </p>
          {totalFailures > 0 ? (
            <p className="text-muted-foreground">
              {totalFailures.toLocaleString()} {totalFailures === 1 ? "call didn’t" : "calls didn’t"}{" "}
              complete.
            </p>
          ) : null}
          {cost ? (
            <p className="text-muted-foreground">
              {summary.costIsEstimated
                ? `That’s roughly ${cost} at list prices — an estimate. Your provider’s own dashboard has the real number.`
                : `That’s ${cost}, from your provider’s own reporting.`}
            </p>
          ) : null}
          {summary.unpricedCalls > 0 ? (
            <p className="text-xs text-muted-foreground">
              {summary.unpricedCalls.toLocaleString()}{" "}
              {summary.unpricedCalls === 1 ? "call has" : "calls have"} no estimate — the provider
              reported no token counts or the model isn’t in Orbit’s price list — so{" "}
              {summary.unpricedCalls === 1 ? "it isn’t" : "they aren’t"} in that figure.
            </p>
          ) : null}
        </div>
      )}
    </SettingsSection>
  );
}
