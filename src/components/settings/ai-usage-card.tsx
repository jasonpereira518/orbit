"use client";

import { useEffect, useState } from "react";
import { getMyAiUsage } from "@/actions/usage";
import { formatCostMicros } from "@/lib/ai-pricing";
import type { UsageSummary } from "@/lib/usage-summary-types";
import { SettingsSection } from "@/components/settings/settings-section";

/**
 * The last 30 days of AI calls made with this user's key, by feature, with estimated cost.
 * An estimate from list prices, labelled as one: the provider's bill is the real number.
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

  return (
    <SettingsSection
      title="AI usage"
      description="Calls made with your key in the last 30 days, and roughly what they cost at list prices. Your provider’s bill is the real number."
    >
      {unavailable ? (
        <p className="text-sm text-muted-foreground">Usage isn’t available right now.</p>
      ) : !summary ? (
        <p className="text-sm text-muted-foreground">Loading usage…</p>
      ) : summary.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No AI calls in the last 30 days.</p>
      ) : (
        <div className="space-y-2">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-sm tabular-nums">
              <thead>
                <tr className="border-b border-border/60 text-xs text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-medium">Feature</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">Calls</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">Tokens</th>
                  <th scope="col" className="py-1.5 text-right font-medium">Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((row) => (
                  <tr key={row.operation} className="border-b border-border/40 last:border-b-0">
                    <td className="py-1.5 pr-3 text-ink">{row.label}</td>
                    <td className="py-1.5 pr-3 text-right">
                      {row.calls.toLocaleString()}
                      {row.failures > 0 ? (
                        <span className="text-muted-foreground"> ({row.failures.toLocaleString()} didn’t complete)</span>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-3 text-right">{(row.inputTokens + row.outputTokens).toLocaleString()}</td>
                    <td className="py-1.5 text-right">{formatCostMicros(row.costMicros) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border/60 font-medium">
                  <td className="py-1.5 pr-3">Total</td>
                  <td className="py-1.5 pr-3 text-right">{summary.totalCalls.toLocaleString()}</td>
                  <td className="py-1.5 pr-3" />
                  <td className="py-1.5 text-right">{formatCostMicros(summary.totalCostMicros) ?? "—"}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {summary.unpricedCalls > 0 ? (
            <p className="text-xs text-muted-foreground">
              {summary.unpricedCalls.toLocaleString()} {summary.unpricedCalls === 1 ? "call has" : "calls have"} no
              estimate — the provider reported no token counts or the model isn’t in Orbit’s price
              list — so {summary.unpricedCalls === 1 ? "it isn’t" : "they aren’t"} in the total.
            </p>
          ) : null}
        </div>
      )}
    </SettingsSection>
  );
}
