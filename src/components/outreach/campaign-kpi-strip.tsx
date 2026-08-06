import { formatReplyRate } from "@/lib/outreach-metrics";
import type { CampaignMetrics } from "@/lib/outreach-types";

export function CampaignKpiStrip({ metrics }: { metrics: CampaignMetrics }) {
  const items = [
    {
      label: "Successful reply rate",
      value: formatReplyRate(metrics.successfulReplyRate),
      primary: true,
    },
    { label: "Sent", value: String(metrics.sentCount) },
    { label: "Positive replies", value: String(metrics.positiveReplyCount) },
    { label: "Awaiting reply", value: String(metrics.awaitingReplyCount) },
    {
      label: "Follow-ups due",
      value: String(metrics.pendingFollowUpCount),
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {items.map((item) => (
        <div
          key={item.label}
          className={`rounded-xl border border-border/70 px-4 py-3 ${
            item.primary ? "bg-primary/5" : "bg-card"
          }`}
        >
          <div className="text-xs text-muted-foreground">{item.label}</div>
          <div
            className={`mt-1 font-[family-name:var(--font-display)] text-2xl ${
              item.primary ? "text-primary" : "text-foreground"
            }`}
          >
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}
